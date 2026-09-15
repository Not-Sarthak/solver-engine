import type { Address, PublicClient } from "viem";
import { confirmations, DEPOSIT_CONFIRMATIONS, DEPOSIT_FINALITY, depositKey, findDeposit, findTransfer, stillPresent } from "../chain/deposits";
import { FailureReason } from "../orders/failures";
import { type FillEngine } from "./fill-engine";
import { type createInventory } from "../orders/inventory";
import { logger } from "../lib/logger";
import { applyBps } from "../lib/math";
import { isTerminal, OrderState, type Order, type createOrderStore } from "../orders/state-machine";
import { type createQuoteStore } from "../orders/quotes";

export type ExecutionOutcome = {
    order: Order;
    txHash: string | null;
    gasUsed: bigint;
    realisedProfit: bigint;
};

// the states a held deposit can be given back from: the refund path proper, and every way a fill
// can not happen after the deposit arrived
const REFUNDABLE = new Set<OrderState>([
    OrderState.REFUNDING,
    OrderState.REFUND_FAILED,
    OrderState.FILL_FAILED,
    OrderState.INSUFFICIENT_INVENTORY,
    OrderState.EXPIRED,
]);

// what the deposit watcher reports back to whoever scheduled it
export type DepositOutcome = { order: Order; status: "confirmed" | "waiting" | "expired" | "ignored" };

// a rebalance is an inventory operation, not an order state: the order is already settled when it
// runs, and whether it happens changes what the solver holds, not what the user was owed
export type RebalanceOutcome = { status: "rebalanced" | "skipped" | "failed"; detail: string };

type ExecutorParams = {
    quotes: ReturnType<typeof createQuoteStore>;
    orders: ReturnType<typeof createOrderStore>;
    inventory: ReturnType<typeof createInventory>;
    fillEngines: ReadonlyMap<number, FillEngine>;
    // every chain the solver can read, for finding and re-checking deposits on an origin
    readers: ReadonlyMap<number, PublicClient>;
    // the account that signs: what a payout or a refund is sent from, when one has to be found
    solver: Address;
    // the quote charged this much for the price moving between quote and fill; the rebalance
    // swap is allowed to land that far under what the quote valued the deposit at
    riskBps: bigint;
    // deposits already matched to an order, so two orders for the same amount cannot claim one
    // transfer. rebuilt from stored orders on restart, so a restart cannot re-claim one either.
    claimed: Set<string>;
    // what the same intent would be quoted right now, or null when it cannot be
    reprice(orderId: string): Promise<bigint | null>;
    now: () => number;
};

type RecoverParams = { orderId: string; chainId: number; recipient: Address; tokenOut: Address };

type ExecuteParams = { orderId: string; chainId: number; recipient: Address; tokenOut: Address; amountIn: bigint; deadlineMs: number };

// three stages, each idempotent by order state so a queue can retry any of them freely.
//
//   awaitDeposit   AWAITING_DEPOSIT  -> DEPOSIT_CONFIRMED   the user's transfer landed and has depth
//   execute        DEPOSIT_CONFIRMED -> FILLED -> SETTLED   pay the user, then confirm we were paid
//   settle         SETTLEMENT_FAILED -> SETTLED             retry the finality check
//   rebalance      SETTLED                                  put a cross-chain deposit back to work
//
// the order of the middle stage is the whole business: the deposit is confirmed before anything is
// paid out, and the payout is verified before the deposit is treated as ours to keep.
export function createExecutor({ quotes, orders, inventory, fillEngines, readers, solver, riskBps, claimed, reprice, now }: ExecutorParams) {
    async function awaitDeposit(orderId: string, deadlineMs: number): Promise<DepositOutcome> {
        const order = orders.get(orderId);

        if (order === null) {
            throw new Error(`No order ${orderId}`);
        }

        if (order.state !== OrderState.AWAITING_DEPOSIT || order.depositWanted === null) {
            return { order, status: "ignored" };
        }

        const wanted = order.depositWanted;
        const client = readers.get(wanted.chainId);

        if (client === undefined) {
            throw new Error(`No reader for chain ${wanted.chainId}`);
        }

        const deposit = order.deposit ?? (await findDeposit({ client, ...wanted, claimed }));

        // the deadline is about whether the user sent the deposit in time, not about how long the
        // chain takes to bury it. so it is checked against the block the transfer landed in, and
        // only decides anything once there is no transfer to look at. checking the clock first
        // expired orders whose deposit was already on chain and still gathering confirmations.
        if (deposit === null) {
            if (now() < deadlineMs) {
                return { order, status: "waiting" };
            }

            return {
                order: await orders.advance({
                    orderId,
                    to: OrderState.EXPIRED,
                    atMs: now(),
                    reason: FailureReason.DEPOSIT_CONFIRMATION_TIMEOUT,
                    quoteId: null,
                }),
                status: "expired",
            };
        }

        if (order.deposit === null) {
            claimed.add(depositKey(deposit));
            await orders.attach(orderId, { deposit });
        }

        if ((await confirmations(client, deposit)) < DEPOSIT_CONFIRMATIONS) {
            return { order: orders.get(orderId)!, status: "waiting" };
        }

        // a transfer mined after the deadline is a deposit the solver holds but never agreed to
        // fill; it goes back. it is credited first, because the refund debits what it returns.
        const { timestamp } = await client.getBlock({ blockNumber: deposit.blockNumber });

        if (timestamp * 1000n > BigInt(deadlineMs)) {
            await inventory.credit({ chainId: wanted.chainId, token: wanted.token, amount: wanted.amount });

            return {
                order: await orders.advance({
                    orderId,
                    to: OrderState.EXPIRED,
                    atMs: now(),
                    reason: FailureReason.ORDER_EXPIRED,
                    quoteId: null,
                    detail: `deposit landed at ${timestamp} in block ${deposit.blockNumber}, deadline was ${Math.floor(deadlineMs / 1000)}`,
                }),
                status: "expired",
            };
        }

        // the deposit is the solver's now, on the origin chain, in the token the user sent
        await inventory.credit({ chainId: wanted.chainId, token: wanted.token, amount: wanted.amount });

        return {
            order: await orders.advance({ orderId, to: OrderState.DEPOSIT_CONFIRMED, atMs: now(), reason: null, quoteId: null }),
            status: "confirmed",
        };
    }

    async function execute({ orderId, chainId, recipient, tokenOut, amountIn }: ExecuteParams): Promise<ExecutionOutcome> {
        const order = orders.get(orderId);

        if (order === null) {
            throw new Error(`No order ${orderId}`);
        }

        // the state machine is the idempotency guard: anything past DEPOSIT_CONFIRMED has already
        // been executed or is being executed, so a second call observes rather than repeats. the
        // one re-entry is PAYOUT_FAILED, where the swap is done and only the transfer is owed.
        const payoutOnly = order.state === OrderState.PAYOUT_FAILED;

        if ((order.state !== OrderState.DEPOSIT_CONFIRMED && !payoutOnly) || order.depositWanted === null) {
            logger.info("Execute Ignored: ", { orderId, state: order.state, terminal: isTerminal(order.state) });

            return { order, txHash: null, gasUsed: 0n, realisedProfit: 0n };
        }

        const stored = order.quoteId === null ? null : quotes.get(order.quoteId);

        if (stored === null) {
            throw new Error(`Order ${orderId} has no quote`);
        }

        // the fill happens on the destination chain, so the engine is chosen by that chain, not by
        // wherever the deposit came from
        const fillEngine = fillEngines.get(chainId);

        if (fillEngine === undefined) {
            throw new Error(`No fill engine for chain ${chainId}`);
        }

        const { quotedAmountOut, path, fees } = stored.quote;

        // what the solver spends on the destination is not what the user deposited. a cross-chain
        // fill starts from the bridged hub amount it already holds there; a same-chain fill starts
        // from the deposit itself, which is now in inventory.
        // a payout retry starts from the output the earlier swap left in the account, not from the
        // input, which is gone
        const destinationAmountIn = payoutOnly ? quotedAmountOut : path.bridge === null ? amountIn : path.bridge.bridgedAmount;
        const destinationTokenIn = payoutOnly ? tokenOut : path.bridge === null ? order.depositWanted.token : (path.legs[0]?.tokenIn ?? tokenOut);
        const request = {
            orderId,
            legs: payoutOnly ? [] : path.legs,
            tokenOut,
            recipient,
            amountIn: destinationAmountIn,
            minAmountOut: quotedAmountOut,
            payoutAmount: quotedAmountOut,
        };
        const fail = async (to: OrderState, reason: FailureReason, detail?: string) => ({
            order: await orders.advance({ orderId, to, atMs: now(), reason, quoteId: null, detail }),
            txHash: null,
            gasUsed: 0n,
            realisedProfit: 0n,
        });

        // what is reserved is what the fill spends, not what the user is owed: a swap route pays the
        // user out of its own output, so the solver needs the input on hand, not the output
        const reservation = await inventory.reserve({ orderId, chainId, token: destinationTokenIn, amount: destinationAmountIn });

        if (!reservation.ok) {
            return fail(OrderState.INSUFFICIENT_INVENTORY, reservation.reason);
        }

        // pinned before anything is sent: if this process dies mid-fill, the next one looks for
        // the payout from this block on
        const destinationReader = readers.get(chainId);

        if (destinationReader === undefined) {
            throw new Error(`No reader for chain ${chainId}`);
        }

        await orders.attach(orderId, { fillFromBlock: await destinationReader.getBlockNumber({ cacheTime: 0 }) });
        await orders.advance({ orderId: order.id, to: OrderState.FILLING, atMs: now(), reason: null, quoteId: null });

        // the quote was a price at one moment and the deposit arrived at another. the risk buffer
        // is what the solver charged for that gap; a move larger than it is a fill at a loss, and
        // the user's deposit goes back instead. a price that cannot be found now is treated the same.
        if (!payoutOnly) {
            const fresh = await reprice(orderId);

            if (fresh === null || fresh < quotedAmountOut - fees.riskBuffer) {
                logger.warn("Fill Refused: ", {
                    orderId,
                    reason: "price moved",
                    quoted: quotedAmountOut.toString(),
                    fresh: fresh?.toString() ?? null,
                });
                await inventory.release(orderId);

                return {
                    order: await orders.advance({
                        orderId,
                        to: OrderState.REFUNDING,
                        atMs: now(),
                        reason: null,
                        quoteId: null,
                        detail:
                            fresh === null
                                ? "the intent cannot be priced any more"
                                : `quoted ${quotedAmountOut}, would quote ${fresh} now, buffer was ${fees.riskBuffer}`,
                    }),
                    txHash: null,
                    gasUsed: 0n,
                    realisedProfit: 0n,
                };
            }
        }

        const simulated = payoutOnly ? { ok: true as const } : await fillEngine.dryRun(request);

        // relay's fast-refund path: a fill that cannot happen is refunded immediately rather than
        // left to expire. the refund is a transaction of its own, sent by the next stage.
        if (!simulated.ok) {
            logger.warn("Fill Refused: ", { orderId, reason: simulated.reason, detail: simulated.detail });
            await inventory.release(orderId);

            return {
                order: await orders.advance({
                    orderId,
                    to: OrderState.REFUNDING,
                    atMs: now(),
                    reason: null,
                    quoteId: null,
                    detail: simulated.detail,
                }),
                txHash: null,
                gasUsed: 0n,
                realisedProfit: 0n,
            };
        }

        const filled = await fillEngine.fill(request);

        if (!filled.ok) {
            // nothing moved: the input is still here, and the deposit goes back
            if (filled.swapped === undefined) {
                await inventory.release(orderId);

                return fail(OrderState.FILL_FAILED, filled.reason, filled.detail);
            }

            // the swap happened: the input is spent and the output is held, whatever came after.
            // releasing the reservation here would put spent tokens back on the ledger.
            await inventory.commit(orderId);
            await inventory.credit({ chainId, token: tokenOut, amount: filled.swapped.amountOut });
            logger.warn("Fill Stopped After Swap: ", { orderId, reason: filled.reason, detail: filled.detail, swapTx: filled.swapped.txHash });

            // the user is still owed the quote and the output is here to pay it: retry the payout
            if (filled.reason === FailureReason.PAYOUT_FAILED) {
                return fail(OrderState.PAYOUT_FAILED, filled.reason, filled.detail);
            }

            // under the quote there is nothing to pay the quote with. on the same chain the deposit
            // itself was swapped, so what goes back is its output; across chains the deposit is
            // untouched on the origin and goes back as it is, and the output stays as inventory
            if (path.bridge === null) {
                await orders.attach(orderId, { owed: { chainId, token: tokenOut, amount: filled.swapped.amountOut } });
            }

            return fail(OrderState.FILL_FAILED, filled.reason, filled.detail);
        }

        // the swap consumed its input and produced its output; the payout left with the user
        await inventory.commit(orderId);
        await inventory.credit({ chainId, token: tokenOut, amount: filled.measurement.amountOut });
        await inventory.debit({ chainId, token: tokenOut, amount: quotedAmountOut });

        // on a fork the ledger and the chain cannot disagree, because every write to the fork went
        // through this process. live they can, so the chain wins.
        const onChain = await fillEngine.balanceOf(tokenOut);

        if (onChain !== null) {
            await inventory.reconcile(chainId, tokenOut, onChain);
        }

        await orders.attach(orderId, { fillTx: filled.measurement.txHash });
        await orders.advance({ orderId, to: OrderState.FILLED, atMs: now(), reason: null, quoteId: null });

        const settled = await settle(orderId);
        const realisedProfit = filled.measurement.amountOut - quotedAmountOut;

        logger.info("Order Filled: ", {
            orderId,
            txHash: filled.measurement.txHash,
            gasUsed: filled.measurement.gasUsed.toString(),
            delivered: filled.measurement.delivered.toString(),
            received: filled.measurement.amountOut.toString(),
            realisedProfit: realisedProfit.toString(),
            state: settled.state,
        });

        return { order: settled, txHash: filled.measurement.txHash, gasUsed: filled.measurement.gasUsed, realisedProfit };
    }

    // the user has been paid. settlement is confirming the solver was too: the deposit is still where
    // it landed, and has enough depth that it is not coming back out. from FILLED, a deposit that is
    // gone is a reorg and the solver is out of pocket; from SETTLEMENT_FAILED it is retried, because
    // the failure may have been the rpc rather than the chain.
    async function settle(orderId: string): Promise<Order> {
        const order = orders.get(orderId);

        if (order === null) {
            throw new Error(`No order ${orderId}`);
        }

        if (order.state !== OrderState.FILLED && order.state !== OrderState.SETTLEMENT_FAILED) {
            return order;
        }

        if (order.deposit === null) {
            throw new Error(`Order ${orderId} reached settlement without a deposit`);
        }

        const client = readers.get(order.deposit.chainId);

        if (client === undefined) {
            throw new Error(`No reader for chain ${order.deposit.chainId}`);
        }

        await orders.advance({ orderId, to: OrderState.SETTLING, atMs: now(), reason: null, quoteId: null });

        const retry = (reason: FailureReason, detail: string) =>
            orders.advance({ orderId, to: OrderState.SETTLEMENT_FAILED, atMs: now(), reason, quoteId: null, detail });

        let present: boolean;

        try {
            present = await stillPresent(client, order.deposit);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn("Settlement Check Failed: ", { orderId, message });

            return retry(FailureReason.SETTLEMENT_REJECTED, message.split("\n")[0] ?? message);
        }

        // the deposit is gone from the block it landed in: the fill was paid for by nothing
        if (!present) {
            return orders.advance({ orderId, to: OrderState.DEPOSIT_REORGED, atMs: now(), reason: FailureReason.DEPOSIT_REORGED, quoteId: null });
        }

        // present but shallow: not a failure, just not final yet. the queue asks again.
        const depth = await confirmations(client, order.deposit);

        if (depth < DEPOSIT_FINALITY) {
            return retry(FailureReason.SETTLEMENT_REJECTED, `deposit is ${depth} deep, finality is ${DEPOSIT_FINALITY}`);
        }

        return orders.advance({ orderId, to: OrderState.SETTLED, atMs: now(), reason: null, quoteId: null });
    }

    // the deposit goes back to whoever sent it, on the chain it came from, in the token it came in.
    // it is a real transfer signed by the solver: the order is only REFUNDED once the chain has it.
    // a send that fails leaves the order retryable, because the deposit is still held and giving
    // up would mean keeping it.
    async function refund(orderId: string): Promise<Order> {
        const order = orders.get(orderId);

        if (order === null) {
            throw new Error(`No order ${orderId}`);
        }

        if (!REFUNDABLE.has(order.state)) {
            return order;
        }

        // expired with nothing received is the end of the order; there is nothing to give back
        if (order.deposit === null) {
            if (order.state === OrderState.EXPIRED) {
                return order;
            }

            throw new Error(`Order ${orderId} is ${order.state} without a deposit`);
        }

        // what goes back, and where: the output a same-chain swap turned the deposit into, or the
        // deposit itself; to the address the user named, or to whoever sent the deposit
        const { chainId, token, amount } = order.owed ?? order.deposit;
        const to = order.depositWanted?.refundTo ?? order.deposit.from;
        const fillEngine = fillEngines.get(chainId);
        const client = readers.get(order.deposit.chainId);

        if (fillEngine === undefined || client === undefined) {
            throw new Error(`No fill engine for chain ${chainId}`);
        }

        if (order.state !== OrderState.REFUNDING) {
            await orders.advance({
                orderId,
                to: OrderState.REFUNDING,
                atMs: now(),
                reason: null,
                quoteId: null,
                detail: order.failureDetail ?? undefined,
            });
        }

        // a refund of a transfer that a reorg then removes is money given away for nothing, so the
        // deposit has to be as deep as it would be before a fill
        const depth = await confirmations(client, order.deposit);

        if (depth < DEPOSIT_CONFIRMATIONS) {
            return orders.advance({
                orderId,
                to: OrderState.REFUND_FAILED,
                atMs: now(),
                reason: FailureReason.REFUND_REJECTED,
                quoteId: null,
                detail: `deposit is ${depth} deep, refunds need ${DEPOSIT_CONFIRMATIONS}`,
            });
        }

        const sent = await fillEngine.fill({
            orderId,
            legs: [],
            tokenOut: token,
            recipient: to,
            amountIn: amount,
            minAmountOut: 0n,
            payoutAmount: amount,
        });

        if (!sent.ok) {
            logger.warn("Refund Failed: ", { orderId, chainId, reason: sent.reason, detail: sent.detail });

            return orders.advance({
                orderId,
                to: OrderState.REFUND_FAILED,
                atMs: now(),
                reason: FailureReason.REFUND_REJECTED,
                quoteId: null,
                detail: sent.detail,
            });
        }

        await inventory.debit({ chainId, token, amount });
        await orders.attach(orderId, { refundTx: sent.measurement.txHash });

        logger.info("Refunded: ", { orderId, chainId, token, amount: amount.toString(), to, txHash: sent.measurement.txHash });

        return orders.advance({ orderId, to: OrderState.REFUNDED, atMs: now(), reason: null, quoteId: null });
    }

    // a cross-chain fill leaves the solver long the deposited token on the origin. the quote priced
    // the swap out of it into the hub asset and charged the user for that gas, so it is executed
    // here as the last step. an origin the solver cannot sign on is skipped, and says so.
    async function rebalance(orderId: string): Promise<RebalanceOutcome> {
        const order = orders.get(orderId);

        if (order === null) {
            throw new Error(`No order ${orderId}`);
        }

        if (order.state !== OrderState.SETTLED || order.depositWanted === null) {
            return { status: "skipped", detail: `order is ${order.state}` };
        }

        const stored = order.quoteId === null ? null : quotes.get(order.quoteId);
        const bridge = stored?.quote.path.bridge ?? null;

        if (bridge === null || bridge.originLegs.length === 0) {
            return { status: "skipped", detail: "the deposit already is the hub asset" };
        }

        const fillEngine = fillEngines.get(bridge.originChainId);

        if (fillEngine === undefined) {
            logger.warn("Rebalance Skipped: ", { orderId, originChainId: bridge.originChainId, detail: "no signer on the origin" });

            return { status: "skipped", detail: "no signer on the origin" };
        }

        const { token, amount } = order.depositWanted;
        const hubToken = bridge.originLegs[bridge.originLegs.length - 1]!.tokenOut;
        const result = await fillEngine.fill({
            orderId,
            legs: bridge.originLegs,
            tokenOut: hubToken,
            recipient: order.depositWanted.to,
            amountIn: amount,
            minAmountOut: bridge.originAmountOut - applyBps({ value: bridge.originAmountOut, bps: riskBps }),
            payoutAmount: 0n,
        });

        if (!result.ok) {
            logger.warn("Rebalance Failed: ", { orderId, reason: result.reason, detail: result.detail });

            return { status: "failed", detail: result.detail };
        }

        await inventory.debit({ chainId: bridge.originChainId, token, amount });
        await inventory.credit({ chainId: bridge.originChainId, token: hubToken, amount: result.measurement.amountOut });

        logger.info("Rebalanced: ", {
            orderId,
            originChainId: bridge.originChainId,
            asset: bridge.asset,
            valuedAt: bridge.originAmountOut.toString(),
            received: result.measurement.amountOut.toString(),
            gasUsed: result.measurement.gasUsed.toString(),
            txHash: result.measurement.txHash,
        });

        return { status: "rebalanced", detail: result.measurement.txHash };
    }

    // an order that was mid-transaction when the last process died. the chain is asked whether the
    // transaction went out: a payout to the recipient for exactly the quote from the block the fill
    // started at, or a refund to the depositor for exactly the deposit from the block it landed in.
    // found, the order carries on from there. not found, nothing is sent again, because a receipt
    // this process never saw is not the same as a transaction that never happened: a person looks.
    async function recover({ orderId, chainId, recipient, tokenOut }: RecoverParams): Promise<Order> {
        const order = orders.get(orderId);

        if (order === null) {
            throw new Error(`No order ${orderId}`);
        }

        const review = (detail: string) =>
            orders.advance({ orderId, to: OrderState.NEEDS_REVIEW, atMs: now(), reason: FailureReason.INTERRUPTED, quoteId: null, detail });

        if (order.state === OrderState.FILLING) {
            const stored = order.quoteId === null ? null : quotes.get(order.quoteId);
            const client = readers.get(chainId);

            if (stored === null || client === undefined || order.fillFromBlock === null) {
                return review("interrupted mid-fill with no block to look for the payout from");
            }

            const payout = await findTransfer({
                client,
                token: tokenOut,
                from: solver,
                to: recipient,
                amount: stored.quote.quotedAmountOut,
                fromBlock: order.fillFromBlock,
            });

            if (payout === null) {
                return review(`interrupted mid-fill and no payout of ${stored.quote.quotedAmountOut} found from block ${order.fillFromBlock}`);
            }

            logger.warn("Fill Recovered: ", { orderId, txHash: payout.txHash, blockNumber: payout.blockNumber.toString() });

            if (inventory.hasReservation(orderId)) {
                await inventory.commit(orderId);
            }

            await orders.attach(orderId, { fillTx: payout.txHash });
            await orders.advance({ orderId, to: OrderState.FILLED, atMs: now(), reason: null, quoteId: null });

            return settle(orderId);
        }

        if (order.state === OrderState.REFUNDING && order.deposit !== null) {
            // the same transfer refund() would send, looked for from the block the deposit landed
            // in (the swap that produced an owed output came later than that on the same chain)
            const { chainId: origin, token, amount } = order.owed ?? order.deposit;
            const to = order.depositWanted?.refundTo ?? order.deposit.from;
            const client = readers.get(origin);

            if (client === undefined) {
                return review("interrupted mid-refund on a chain this process cannot read");
            }

            const sent = await findTransfer({ client, token, from: solver, to, amount, fromBlock: order.deposit.blockNumber });

            if (sent === null) {
                return review(`interrupted mid-refund and no refund of ${amount} to ${to} found from block ${order.deposit.blockNumber}`);
            }

            logger.warn("Refund Recovered: ", { orderId, txHash: sent.txHash });
            await inventory.debit({ chainId: origin, token, amount });
            await orders.attach(orderId, { refundTx: sent.txHash });

            return orders.advance({ orderId, to: OrderState.REFUNDED, atMs: now(), reason: null, quoteId: null });
        }

        return order;
    }

    return { awaitDeposit, execute, settle, refund, rebalance, recover };
}
