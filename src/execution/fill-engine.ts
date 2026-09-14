import { concat, encodeFunctionData, keccak256, numberToHex } from "viem";
import type { Address, Hash, PublicClient, StateOverride, TestClient, WalletClient } from "viem";
import type { LocalAccount } from "viem/accounts";
import { erc20Abi, swapRouterAbi, v2RouterAbi, v3RouterWithDeadlineAbi } from "../chain/abis";
import { allowanceOverride, balanceOverride, dealToken } from "../chain/deal";
import { candidatePools } from "../chain/discovery";
import type { ChainConfig } from "../chain/chain-registry";
import { FailureReason } from "../orders/failures";
import { isSameAddress } from "../lib/address";
import { logger } from "../lib/logger";
import type { PathLeg } from "../quoting/routing";

export type ExecutionRequest = {
    orderId: string;
    legs: PathLeg[];
    // carried explicitly because a pure bridge has no legs to read them off: the solver already
    // holds what the user asked for and the fill is the payout itself.
    tokenOut: Address;
    recipient: Address;
    amountIn: bigint;
    minAmountOut: bigint;
    // exactly what the user was quoted. the solver swaps into its own account and then hands this
    // much over, keeping the difference: paying out the whole swap output instead would give the
    // margin away, and paying before checking would give it away on a bad fill.
    payoutAmount: bigint;
};

type ExecutionMeasurement = {
    // what the solver ended up holding, which is what its profit is measured against
    amountOut: bigint;
    // what the user actually received
    delivered: bigint;
    gasUsed: bigint;
    txHash: Hash;
};

// what a swap that already happened did, carried on a failure that came after it: the input is
// spent and the output is held whether or not the user was paid, and the ledger has to know
export type SwapDone = { amountOut: bigint; gasUsed: bigint; txHash: Hash };

export type ExecutionResult =
    { ok: true; measurement: ExecutionMeasurement } | { ok: false; reason: FailureReason; detail: string; swapped?: SwapDone };

export type FillEngine = {
    gasForRoute(legs: PathLeg[], amountIn: bigint): Promise<bigint | null>;
    gasForPayout(token: Address, amount: bigint): Promise<bigint | null>;
    gasForDeposit(legs: PathLeg[], amountIn: bigint): Promise<bigint | null>;
    dryRun(request: ExecutionRequest): Promise<ExecutionResult>;
    // the account's real balance, or null on a fork where the in-process ledger is already exact
    balanceOf(token: Address): Promise<bigint | null>;
    fill(request: ExecutionRequest): Promise<ExecutionResult>;
    forget(pools: readonly Address[]): number;
};

type FillEngineParams = {
    chain: ChainConfig;
    publicClient: PublicClient;
    walletClient: WalletClient;
    testClient: TestClient | null;
    signer: LocalAccount;
    // how long a gas measurement is trusted. gas moves a little as a pool's ticks shift, well
    // inside the risk buffer, but a route that failed to execute is remembered as failing, and
    // this is how long that verdict can stand before it is checked again
    gasCacheTtlMs: number;
    now: () => number;
};

// a derived address that already holds the token would measure the wrong transfer shape, so a few
// are tried. one is almost always enough; the loop exists so the failure is loud rather than silent.
const EMPTY_HOLDER_ATTEMPTS = 8;

// the fork has no clock worth respecting and the fill is one transaction, so the deadline exists
// only to satisfy the signature every v2 router still carries.
const DEADLINE_NEVER = 2n ** 32n - 1n;

// a revert is typed by what the chain said, so the same message means the same thing whether it
// came back as a thrown estimate or as a receipt that was replayed for its reason
function classify(message: string): FailureReason {
    return /Too little received|amountOutMinimum|STF|slippage/i.test(message)
        ? FailureReason.SLIPPAGE
        : /out of gas|gas required exceeds|intrinsic gas/i.test(message)
          ? FailureReason.SWAP_USES_TOO_MUCH_GAS
          : FailureReason.EXECUTION_REVERTED;
}

// every number here comes from a transaction that actually ran: gasUsed off the receipt, amountOut
// off the balance delta. a dry run is the same execution wrapped in an anvil snapshot and rolled
// back, so pricing sees what the fill will see rather than an estimate of it.
export function createFillEngine({ chain, publicClient, walletClient, testClient, signer, gasCacheTtlMs, now }: FillEngineParams): FillEngine {
    const owner = signer.address;
    const approved = new Set<string>();
    // negatives are cached too: a route that cannot execute will not start working, and retrying it
    // on every quote cost about 2.5s per failing route. the promise is what is cached, so two quotes
    // arriving together measure a route once rather than racing each other for it.
    const gasByRoute = new Map<string, { gas: Promise<bigint | null>; measuredAtMs: number }>();
    // everything that writes to the chain from this account runs one at a time. on a fork a
    // measurement is a snapshot and a revert around real transactions, and a second writer in
    // between would either have its transaction rolled back or collide on the nonce; two quotes
    // measuring at once did exactly that. live it is the nonce alone, and the same rule holds.
    let turn: Promise<unknown> = Promise.resolve();

    function exclusive<T>(task: () => Promise<T>): Promise<T> {
        const next = turn.then(task, task);
        turn = next.catch(() => undefined);

        return next;
    }

    // a leg names a pool, and which deployment that pool belongs to says which router can trade it
    // and how that router expects to be called: two amms can hold the same pair at the same fee and
    // neither router can reach the other's pool. the answer is derived from the leg's own tokens,
    // the same way the pool was found, so a fill needs nothing loaded: after a restart the quote is
    // all there is, and it is enough.
    function originOf(leg: PathLeg) {
        const pool = candidatePools(chain, leg.tokenIn, leg.tokenOut).find((candidate) => isSameAddress(candidate.address, leg.quote.poolId));
        const amm = pool === undefined ? undefined : chain.amms.find((candidate) => candidate.id === pool.ammId);

        if (pool === undefined || amm === undefined || amm.kind !== pool.kind) {
            return null;
        }

        return amm.kind === "v3"
            ? { kind: "v3" as const, router: pool.router, feeTier: pool.feeTier, ammId: amm.id, takesDeadline: amm.routerTakesDeadline }
            : { kind: "v2" as const, router: pool.router, takesDeadline: amm.routerTakesDeadline, ammId: amm.id };
    }

    // one leg is a single swap on its own router. more than one is chained through the packed path
    // the router understands, which carries each leg output into the next inside one call: encoding
    // the legs separately does not chain them, a later leg given amountIn 0 swaps nothing, and that
    // is why every multi-hop route used to fail. a packed path lives inside one router, so every leg
    // must be v3 and on the same deployment; a route that crosses amms is dropped, not mis-encoded.
    function callData({ legs, amountIn, minAmountOut }: ExecutionRequest): { to: Address; data: `0x${string}` } | null {
        const origins = legs.map((leg) => originOf(leg));

        if (origins.some((origin) => origin === null)) {
            return null;
        }

        if (legs.length === 1) {
            const [leg] = legs as [PathLeg];
            const origin = origins[0]!;

            if (origin.kind === "v3") {
                const single = {
                    tokenIn: leg.tokenIn,
                    tokenOut: leg.tokenOut,
                    fee: origin.feeTier,
                    recipient: owner,
                    amountIn,
                    amountOutMinimum: minAmountOut,
                    sqrtPriceLimitX96: 0n,
                };

                return {
                    to: origin.router,
                    data: origin.takesDeadline
                        ? encodeFunctionData({
                              abi: v3RouterWithDeadlineAbi,
                              functionName: "exactInputSingle",
                              args: [{ ...single, deadline: DEADLINE_NEVER }],
                          })
                        : encodeFunctionData({ abi: swapRouterAbi, functionName: "exactInputSingle", args: [single] }),
                };
            }

            const path = [leg.tokenIn, leg.tokenOut];

            return {
                to: origin.router,
                data: origin.takesDeadline
                    ? encodeFunctionData({
                          abi: v2RouterAbi,
                          functionName: "swapExactTokensForTokens",
                          args: [amountIn, minAmountOut, path, owner, DEADLINE_NEVER],
                      })
                    : encodeFunctionData({
                          abi: swapRouterAbi,
                          functionName: "swapExactTokensForTokens",
                          args: [amountIn, minAmountOut, path, owner],
                      }),
            };
        }

        if (origins.some((origin) => origin!.kind !== "v3" || origin!.ammId !== origins[0]!.ammId)) {
            return null;
        }

        const v3 = origins as { kind: "v3"; router: Address; feeTier: number; ammId: string; takesDeadline: boolean }[];
        const packed = concat([legs[0]!.tokenIn, ...legs.flatMap((leg, index) => [numberToHex(v3[index]!.feeTier, { size: 3 }), leg.tokenOut])]);
        const multi = { path: packed, recipient: owner, amountIn, amountOutMinimum: minAmountOut };

        return {
            to: v3[0]!.router,
            data: v3[0]!.takesDeadline
                ? encodeFunctionData({ abi: v3RouterWithDeadlineAbi, functionName: "exactInput", args: [{ ...multi, deadline: DEADLINE_NEVER }] })
                : encodeFunctionData({ abi: swapRouterAbi, functionName: "exactInput", args: [multi] }),
        };
    }

    async function balanceOf(token: Address, holder: Address): Promise<bigint> {
        return publicClient.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [holder] });
    }

    // one allowance per token per router. approving uniswap does not let sushiswap pull anything, so
    // the cache is keyed by both or the second amm silently fails for no allowance.
    async function ensureApproval(token: Address, spender: Address, amount: bigint): Promise<void> {
        const key = `${token.toLowerCase()}:${spender.toLowerCase()}`;

        if (approved.has(key)) {
            return;
        }

        const allowance = await publicClient.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });

        if (allowance < amount) {
            const hash = await walletClient.writeContract({
                address: token,
                abi: erc20Abi,
                functionName: "approve",
                args: [spender, 2n ** 256n - 1n],
                account: signer,
                chain: walletClient.chain,
            });

            await publicClient.waitForTransactionReceipt({ hash });
        }

        approved.add(key);
    }

    function routerFor(legs: PathLeg[]): Address | null {
        return legs.length === 0 ? null : (originOf(legs[0]!)?.router ?? null);
    }

    async function send(
        to: Address,
        data: `0x${string}`,
    ): Promise<{ ok: true; gasUsed: bigint; txHash: Hash } | { ok: false; reason: FailureReason; detail: string }> {
        const txHash = await walletClient.sendTransaction({ to, data, account: signer, chain: walletClient.chain });
        const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

        if (receipt.status === "success") {
            return { ok: true, gasUsed: receipt.gasUsed, txHash };
        }

        // a receipt says a transaction failed but not why. replaying the same call against the block
        // it landed in surfaces the revert reason, which is the difference between "something broke"
        // and a failure anyone can act on.
        const replayed = await publicClient
            .call({ to, data, account: owner, blockNumber: receipt.blockNumber })
            .then(() => "no reason: the call succeeds on replay")
            .catch((cause: unknown) => (cause instanceof Error ? (cause.message.split("\n")[0] ?? cause.message) : String(cause)));

        return { ok: false, reason: classify(replayed), detail: `transaction ${txHash} reverted: ${replayed}` };
    }

    // a fill is two steps, and they are separate on purpose. the solver swaps into its own account,
    // checks what it got, and only then pays the user. swapping straight to the user would hand them
    // the whole output and leave the solver nothing, and paying before checking would hand them a
    // short fill. a route that already holds what the user asked for skips the first step.
    async function run(request: ExecutionRequest): Promise<ExecutionResult> {
        const outputToken = request.legs[request.legs.length - 1]?.tokenOut ?? request.tokenOut;

        let swapped: SwapDone | null = null;

        try {
            let gasUsed = 0n;
            let acquired = request.amountIn;
            let lastTxHash: Hash | null = null;

            if (request.legs.length > 0) {
                const data = callData(request);

                if (data === null) {
                    return {
                        ok: false,
                        reason: FailureReason.NO_ROUTES,
                        detail: "route spans amms or mixes v2 and v3 legs, which no single router can chain",
                    };
                }

                const before = await balanceOf(outputToken, owner);
                const sent = await send(data.to, data.data);

                if (!sent.ok) {
                    return sent;
                }

                gasUsed += sent.gasUsed;
                lastTxHash = sent.txHash;
                acquired = (await balanceOf(outputToken, owner)) - before;
                swapped = { amountOut: acquired, gasUsed: sent.gasUsed, txHash: sent.txHash };
            }

            if (request.payoutAmount === 0n) {
                // a measurement, not a fill: there is no user waiting on the other end of it
                return { ok: true, measurement: { amountOut: acquired, delivered: 0n, gasUsed, txHash: lastTxHash! } };
            }

            if (acquired < request.payoutAmount) {
                return {
                    ok: false,
                    reason: FailureReason.SLIPPAGE,
                    detail: `fill produced ${acquired} but the user was quoted ${request.payoutAmount}, so nothing was paid out`,
                    ...(swapped === null ? {} : { swapped }),
                };
            }

            const deliveredBefore = await balanceOf(outputToken, request.recipient);
            const paid = await send(
                outputToken,
                encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [request.recipient, request.payoutAmount] }),
            );

            // the swap is done and the user is not paid: the one failure that must not be retried
            // from the top, because the input is already spent
            if (!paid.ok) {
                return { ok: false, reason: FailureReason.PAYOUT_FAILED, detail: paid.detail, ...(swapped === null ? {} : { swapped }) };
            }

            gasUsed += paid.gasUsed;

            return {
                ok: true,
                measurement: {
                    amountOut: acquired,
                    delivered: (await balanceOf(outputToken, request.recipient)) - deliveredBefore,
                    gasUsed,
                    txHash: paid.txHash,
                },
            };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            return {
                ok: false,
                reason: swapped === null ? classify(message) : FailureReason.PAYOUT_FAILED,
                detail: message.split("\n")[0] ?? message,
                ...(swapped === null ? {} : { swapped }),
            };
        }
    }

    // gas is measured once per route and reused. it moves a little with the ticks a swap crosses,
    // but gas is well under a basis point of a quote here, far inside the risk buffer, and the fill
    // measures again before committing. executing every candidate on every quote cost 12.6s at p50.
    function routeKey(legs: PathLeg[]): string {
        return legs.map((leg) => leg.quote.poolId.toLowerCase()).join(">");
    }

    // every gas number is measured once and remembered, negatives included: a route that cannot
    // execute will not start working, and retrying it on every quote cost about 2.5s per failure.
    function remembered(key: string, measure: () => Promise<bigint | null>): Promise<bigint | null> {
        const known = gasByRoute.get(key);

        if (known !== undefined && now() - known.measuredAtMs < gasCacheTtlMs) {
            return known.gas;
        }

        const gas = exclusive(measure);
        gasByRoute.set(key, { gas, measuredAtMs: now() });

        return gas;
    }

    // a pool whose liquidity changed shape may cost different gas to swap through, and a route
    // that could not execute through it may be able to now: every measurement naming it is dropped
    function forget(pools: readonly Address[]): number {
        const lowered = pools.map((pool) => pool.toLowerCase());
        let dropped = 0;

        for (const key of [...gasByRoute.keys()]) {
            if (lowered.some((pool) => key.includes(pool))) {
                gasByRoute.delete(key);
                dropped++;
            }
        }

        return dropped;
    }

    function unmeasurable(reason: string, detail: Record<string, unknown>): null {
        logger.warn(reason, detail);

        return null;
    }

    // a measurement has to leave the chain as it found it. on a fork that is a snapshot around a real
    // send, so the number is a receipt. live there is nothing to snapshot, so the node simulates the
    // same calls: estimateGas is the chain executing the transaction against current state and
    // reporting what it would cost, and it reverts exactly where the transaction would. the output
    // is our own amm math for the legs, which is verified wei-exact against QuoterV2 on that state.
    //
    // `fund` is a balance the account does not hold yet, such as a deposit still on the origin. on a
    // fork it is written into storage inside the snapshot; live it is a state override the node
    // applies to the simulation only, so nothing is written anywhere.
    async function simulate(request: ExecutionRequest, fund: { token: Address; amount: bigint } | null): Promise<ExecutionResult> {
        if (testClient !== null) {
            const snapshot = await testClient.snapshot();

            try {
                if (fund !== null && !(await dealToken({ publicClient, testClient, token: fund.token, holder: owner, amount: fund.amount }))) {
                    return { ok: false, reason: FailureReason.EXECUTION_REVERTED, detail: `could not fund ${fund.token} for the measurement` };
                }

                return await run(request);
            } finally {
                await testClient.revert({ id: snapshot });
            }
        }

        // nothing is sent at quote time. the balance the solver lacks and the approval it has not
        // granted are both overrides the node applies to this simulation and nothing else.
        const stateOverride: StateOverride = [];

        if (fund !== null) {
            const balance = await balanceOverride({ publicClient, token: fund.token, holder: owner, amount: fund.amount });

            if (balance === null) {
                return { ok: false, reason: FailureReason.EXECUTION_REVERTED, detail: `no balance slot found for ${fund.token}` };
            }

            stateOverride.push(...balance);
        }

        if (request.legs.length > 0) {
            const spender = routerFor(request.legs);
            const allowance =
                spender === null
                    ? null
                    : await allowanceOverride({ publicClient, token: request.legs[0]!.tokenIn, owner, spender, amount: request.amountIn });

            if (allowance === null) {
                return { ok: false, reason: FailureReason.EXECUTION_REVERTED, detail: `no allowance slot found for ${request.legs[0]!.tokenIn}` };
            }

            stateOverride.push(...allowance);
        }

        // the balance and the allowance usually live in the same contract, and a node accepts one
        // entry per address, so the diffs are merged before they are sent
        const merged: StateOverride = [];

        for (const entry of stateOverride) {
            const existing = merged.find((candidate) => isSameAddress(candidate.address, entry.address));

            if (existing === undefined) {
                merged.push({ address: entry.address, stateDiff: [...(entry.stateDiff ?? [])] });
            } else {
                existing.stateDiff!.push(...(entry.stateDiff ?? []));
            }
        }

        const outputToken = request.legs[request.legs.length - 1]?.tokenOut ?? request.tokenOut;
        const amountOut = request.legs.length === 0 ? request.amountIn : request.legs[request.legs.length - 1]!.quote.amountOut;

        try {
            let gasUsed = 0n;

            if (request.legs.length > 0) {
                const call = callData(request);

                if (call === null) {
                    return {
                        ok: false,
                        reason: FailureReason.NO_ROUTES,
                        detail: "route spans amms or mixes v2 and v3 legs, which no single router can chain",
                    };
                }

                gasUsed += await publicClient.estimateGas({ account: owner, to: call.to, data: call.data, stateOverride: merged });
            }

            if (request.payoutAmount > 0n) {
                // the payout is estimated as if the swap had already happened: an estimate cannot chain
                // two transactions, so the swap's output is placed in the account by override. a route
                // with no swap gets no such help, because then the account really must hold it.
                const funded =
                    request.legs.length === 0
                        ? []
                        : await balanceOverride({ publicClient, token: outputToken, holder: owner, amount: request.payoutAmount });

                if (funded === null) {
                    return { ok: false, reason: FailureReason.EXECUTION_REVERTED, detail: `no balance slot found for ${outputToken}` };
                }

                gasUsed += await publicClient.estimateGas({
                    account: owner,
                    to: outputToken,
                    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [request.recipient, request.payoutAmount] }),
                    stateOverride: [
                        ...merged.filter((entry) => !funded.some((override) => isSameAddress(override.address, entry.address))),
                        ...funded,
                    ],
                });
            }

            return { ok: true, measurement: { amountOut, delivered: request.payoutAmount, gasUsed, txHash: "0x" as Hash } };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);

            return { ok: false, reason: classify(message), detail: message.split("\n")[0] ?? message };
        }
    }

    return {
        async gasForRoute(legs: PathLeg[], amountIn: bigint): Promise<bigint | null> {
            const key = routeKey(legs);
            const outputToken = legs[legs.length - 1]!.tokenOut;
            const swapGas = await remembered(key, async () => {
                // quote-time probes measure as if the inventory were there; whether it actually is
                // gets decided at accept, when the reservation is taken. the pre-fill dry run does
                // not get this and fails honestly when the account is short.
                const tokenIn = legs[0]!.tokenIn;
                const spender = routerFor(legs);

                if (spender === null) {
                    return unmeasurable("Route Router Unknown: ", { route: key });
                }

                if (testClient !== null) {
                    await ensureApproval(tokenIn, spender, amountIn);
                }

                const short = (await balanceOf(tokenIn, owner)) < amountIn;
                const swapped = await simulate(
                    { orderId: "gas-probe", legs, tokenOut: outputToken, recipient: owner, amountIn, minAmountOut: 0n, payoutAmount: 0n },
                    short ? { token: tokenIn, amount: amountIn } : null,
                );

                return swapped.ok
                    ? swapped.measurement.gasUsed
                    : unmeasurable("Route Not Executable: ", { route: key, reason: swapped.reason, detail: swapped.detail });
            });

            if (swapGas === null) {
                return null;
            }

            // every fill ends by handing the tokens over, so the route costs the swap plus that
            // transfer. the two are measured apart because a transfer is per token, not per route.
            //
            // the amount handed over is what the swap produces, not what goes in. passing the input
            // amount measured a transfer denominated in the wrong token, which for WETH into USDC
            // meant probing a balance a thousand times the solver's own: the probe then wrote that
            // balance in and sent all of it, zeroing the slot and collecting a refund no real fill
            // gets. that quoted the route 21720 gas cheaper than it executes.
            const payoutGas = await this.gasForPayout(outputToken, legs[legs.length - 1]!.quote.amountOut);

            return payoutGas === null ? null : swapGas + payoutGas;
        },

        // the rebalance swap starts from a deposit this fork has never seen, so measuring it means
        // putting the deposit there first. every write is inside the snapshot, the approval included,
        // which is why it is granted directly rather than through the cache that outlives the revert.
        async gasForDeposit(legs: PathLeg[], amountIn: bigint): Promise<bigint | null> {
            const key = `deposit:${routeKey(legs)}`;
            const tokenIn = legs[0]!.tokenIn;
            const spender = routerFor(legs);

            if (spender === null) {
                return unmeasurable("Rebalance Router Unknown: ", { route: key });
            }

            return remembered(key, async () => {
                if (testClient !== null) {
                    await ensureApproval(tokenIn, spender, amountIn);
                }

                const swapped = await simulate(
                    {
                        orderId: "rebalance-probe",
                        legs,
                        tokenOut: legs[legs.length - 1]!.tokenOut,
                        recipient: owner,
                        amountIn,
                        minAmountOut: 0n,
                        payoutAmount: 0n,
                    },
                    { token: tokenIn, amount: amountIn },
                );

                return swapped.ok
                    ? swapped.measurement.gasUsed
                    : unmeasurable("Rebalance Not Executable: ", { route: key, reason: swapped.reason, detail: swapped.detail });
            });
        },

        // one erc20 transfer of a token, measured rather than assumed. it answers two questions with
        // the same transaction: what a destination payout costs when there is no swap to make, and
        // what claiming a deposit costs on the origin chain. the balance is written in when the
        // account is short, because the origin fork has no reason to hold an arbitrary deposit.
        //
        // the recipient has to be an account that holds none of the token, because writing a balance
        // from zero costs about 17k more than updating one that is already set, and a user being paid
        // for the first time is the zero case. it is checked rather than assumed: the obvious
        // constant, 0x1111..1111, already holds USDC on base, so quoting against it understated every
        // payout by that 17k.
        async gasForPayout(token: Address, amount: bigint): Promise<bigint | null> {
            return remembered(`payout:${token.toLowerCase()}`, async () => {
                // an address derived from the token, so it differs per token and is not a place
                // anyone sends anything. the balance is still read back, because "surely nobody
                // holds this" is exactly the assumption that was wrong before.
                let recipient: Address | null = null;

                for (let attempt = 0; attempt < EMPTY_HOLDER_ATTEMPTS && recipient === null; attempt++) {
                    const candidate = `0x${keccak256(concat([token, numberToHex(attempt, { size: 32 })])).slice(-40)}` as Address;

                    if ((await balanceOf(token, candidate)) === 0n) {
                        recipient = candidate;
                    }
                }

                if (recipient === null) {
                    return unmeasurable("No Empty Recipient: ", { token });
                }

                const short = (await balanceOf(token, owner)) < amount;
                const paid = await simulate(
                    { orderId: "payout-probe", legs: [], tokenOut: token, recipient, amountIn: amount, minAmountOut: 0n, payoutAmount: amount },
                    short ? { token, amount } : null,
                );

                return paid.ok
                    ? paid.measurement.gasUsed
                    : unmeasurable("Payout Not Executable: ", { token, reason: paid.reason, detail: paid.detail });
            });
        },

        // approval happens before the snapshot on purpose: granting it inside would be rolled back
        // with everything else, while the in-memory record of it would survive and the next swap
        // would fail for no allowance.
        async balanceOf(token: Address): Promise<bigint | null> {
            return testClient === null ? balanceOf(token, owner) : null;
        },

        // live, the simulation sees the allowance as an override and the real approval waits for
        // the fill, so a dry run that says no has cost nothing
        forget,

        dryRun(request: ExecutionRequest): Promise<ExecutionResult> {
            return exclusive(async () => {
                const spender = routerFor(request.legs);

                if (testClient !== null && request.legs.length > 0 && spender !== null) {
                    await ensureApproval(request.legs[0]!.tokenIn, spender, request.amountIn);
                }

                return simulate(request, null);
            });
        },

        async fill(request: ExecutionRequest): Promise<ExecutionResult> {
            const result = await exclusive(async () => {
                const spender = routerFor(request.legs);

                if (request.legs.length > 0 && spender !== null) {
                    await ensureApproval(request.legs[0]!.tokenIn, spender, request.amountIn);
                }

                return run(request);
            });

            if (result.ok) {
                logger.info("Fill Executed: ", {
                    orderId: request.orderId,
                    txHash: result.measurement.txHash,
                    gasUsed: result.measurement.gasUsed.toString(),
                    amountOut: result.measurement.amountOut.toString(),
                    delivered: result.measurement.delivered.toString(),
                });
            } else {
                logger.warn("Fill Failed: ", { orderId: request.orderId, reason: result.reason, detail: result.detail });
            }

            return result;
        },
    };
}
