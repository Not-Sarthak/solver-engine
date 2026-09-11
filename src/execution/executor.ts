import type { Address, PublicClient } from "viem";
import { confirmations, DEPOSIT_CONFIRMATIONS, DEPOSIT_FINALITY, depositKey, findDeposit, stillPresent } from "../chain/deposits";
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
    // the quote charged this much for the price moving between quote and fill; the rebalance
    // swap is allowed to land that far under what the quote valued the deposit at
    riskBps: bigint;
    // deposits already matched to an order, so two orders for the same amount cannot claim one
    // transfer. rebuilt from stored orders on restart, so a restart cannot re-claim one either.
    claimed: Set<string>;
    now: () => number;
};

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
export function createExecutor({ quotes, orders, inventory, fillEngines, readers, riskBps, claimed, now }: ExecutorParams) {
    async function awaitDeposit(orderId: string, deadlineMs: number): Promise<DepositOutcome> {
        const order = orders.get(orderId);

        if (order === null) {
            throw new Error(`No order ${orderId}`);
        }

        if (order.state !== OrderState.AWAITING_DEPOSIT || order.depositWanted === null) {
            return { order, status: "ignored" };
        }

        if (now() >= deadlineMs) {
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

        const wanted = order.depositWanted;
        const client = readers.get(wanted.chainId);

        if (client === undefined) {
            throw new Error(`No reader for chain ${wanted.chainId}`);
        }

        const deposit = order.deposit ?? (await findDeposit({ client, ...wanted, claimed }));

        if (deposit === null) {
            return { order, status: "waiting" };
        }

        if (order.deposit === null) {
            claimed.add(depositKey(deposit));
            await orders.attach(orderId, { deposit });
        }

        if ((await confirmations(client, deposit)) < DEPOSIT_CONFIRMATIONS) {
            return { order: orders.get(orderId)!, status: "waiting" };
        }

        // the deposit is the solver's now, on the origin chain, in the token the user sent
        inventory.credit({ chainId: wanted.chainId, token: wanted.token, amount: wanted.amount });

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
        // been executed or is being executed, so a second call observes rather than repeats
        if (order.state !== OrderState.DEPOSIT_CONFIRMED || order.depositWanted === null) {
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

        const { quotedAmountOut, path } = stored.quote;

        // what the solver spends on the destination is not what the user deposited. a cross-chain
        // fill starts from the bridged hub amount it already holds there; a same-chain fill starts
        // from the deposit itself, which is now in inventory.
        const destinationAmountIn = path.bridge === null ? amountIn : path.bridge.bridgedAmount;
        const destinationTokenIn = path.bridge === null ? order.depositWanted.token : (path.legs[0]?.tokenIn ?? tokenOut);
        const request = {
            orderId,
            legs: path.legs,
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
        const reservation = inventory.reserve({ orderId, chainId, token: destinationTokenIn, amount: destinationAmountIn });

        if (!reservation.ok) {
            return fail(OrderState.INSUFFICIENT_INVENTORY, reservation.reason);
        }

        await orders.advance({ orderId: order.id, to: OrderState.FILLING, atMs: now(), reason: null, quoteId: null });

        const simulated = await fillEngine.dryRun(request);

        // relay's fast-refund path: a fill that cannot happen is refunded immediately rather than
        // left to expire, and the refund is still settled
        if (!simulated.ok) {
            logger.warn("Fill Refused: ", { orderId, reason: simulated.reason, detail: simulated.detail });
            inventory.release(orderId);
            await orders.advance({ orderId, to: OrderState.REFUNDING, atMs: now(), reason: null, quoteId: null, detail: simulated.detail });

            return {
                order: await orders.advance({ orderId, to: OrderState.REFUNDED, atMs: now(), reason: null, quoteId: null, detail: simulated.detail }),
                txHash: null,
                gasUsed: 0n,
                realisedProfit: 0n,
            };
        }

        const filled = await fillEngine.fill(request);

        if (!filled.ok) {
            inventory.release(orderId);

            return fail(OrderState.FILL_FAILED, filled.reason, filled.detail);
        }

        if (filled.measurement.amountOut < quotedAmountOut) {
            logger.warn("Fill Under Quote: ", { orderId, delivered: filled.measurement.amountOut.toString(), promised: quotedAmountOut.toString() });
            inventory.release(orderId);

            return fail(
                OrderState.FILL_FAILED,
                FailureReason.SLIPPAGE,
                `fill produced ${filled.measurement.amountOut} against a quote of ${quotedAmountOut}`,
            );
        }

        // the swap consumed its input and produced its output; the payout left with the user
        inventory.commit(orderId);
        inventory.credit({ chainId, token: tokenOut, amount: filled.measurement.amountOut });
        inventory.debit({ chainId, token: tokenOut, amount: quotedAmountOut });

        // on a fork the ledger and the chain cannot disagree, because every write to the fork went
        // through this process. live they can, so the chain wins.
        const onChain = await fillEngine.balanceOf(tokenOut);

        if (onChain !== null) {
            inventory.reconcile(chainId, tokenOut, onChain);
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

        inventory.debit({ chainId: bridge.originChainId, token, amount });
        inventory.credit({ chainId: bridge.originChainId, token: hubToken, amount: result.measurement.amountOut });

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

    return { awaitDeposit, execute, settle, rebalance };
}
