import type { Address } from "viem";
import type { Holding } from "./chain/funding";
import type { ChainRuntime } from "./chain/runtime";
import { findBridgedPaths } from "./quoting/bridge";
import { createChainEnvironment } from "./quoting/environment";
import { FailureReason } from "./orders/failures";
import { createFillEngine, type FillEngine } from "./execution/fill-engine";
import { servesIntent, type Intent } from "./orders/intents";
import { createInventory } from "./orders/inventory";
import { logger } from "./lib/logger";
import { createOrder, createOrderStore, OrderState, type Order } from "./orders/state-machine";
import { depositKey } from "./chain/deposits";
import { isSameAddress } from "./lib/address";
import type { Records } from "./orders/records";
import { findPaths, type Path, type PathLeg } from "./quoting/routing";
import { priceQuote, type PricedQuote, type PricingRejection } from "./quoting/pricing";
import { createQuoteStore, type StoredQuote } from "./orders/quotes";
import { createExecutor, type ExecutionOutcome } from "./execution/executor";

type PriceOutcome = { ok: true; priced: PricedQuote } | { ok: false; reason: FailureReason };

type QuoteOutcome = { ok: true; order: Order; quote: StoredQuote } | { ok: false; reason: FailureReason };

type AcceptOutcome = { ok: true; order: Order } | { ok: false; reason: FailureReason };

type SolverParams = {
    chains: ChainRuntime[];
    holdings: Holding[];
    // the address every evm origin's deposit is sent to: the solver's own account
    depositAddress: Address;
    ttlMs: number;
    riskBps: bigint;
    serviceBps: bigint;
    appBps: bigint;
    // where orders, intents and quotes are written, and read back from on restart
    records: { orders: Records<Order>; intents: Records<Intent>; quotes: Records<StoredQuote> };
    now: () => number;
};

export type { Address };

export function createSolver({ chains, holdings, depositAddress, ttlMs, riskBps, serviceBps, appBps, records, now }: SolverParams) {
    const environments = new Map(
        chains.map((runtime) => [
            runtime.chainId,
            createChainEnvironment({
                client: runtime.client,
                chainId: runtime.chainId,
                blockNumber: runtime.blockNumber,
                now,
            }),
        ]),
    );

    const fillEngines = new Map<number, FillEngine>(
        chains
            .filter((runtime) => runtime.fill !== null)
            .map((runtime) => [
                runtime.chainId,
                createFillEngine({
                    chain: environments.get(runtime.chainId)!.chain,
                    publicClient: runtime.fill!.publicClient,
                    walletClient: runtime.fill!.walletClient,
                    testClient: runtime.fill!.testClient,
                    signer: runtime.fill!.signer,
                }),
            ]),
    );

    // where each chain's state actually moves: the fork in fork mode, the chain itself live. a
    // chain with no signer has nothing of ours landing on it, so its own client is the source.
    const syncSources = new Map(
        chains.flatMap((runtime) => (runtime.client === null ? [] : [[runtime.chainId, runtime.fill?.publicClient ?? runtime.client] as const])),
    );

    const quotes = createQuoteStore({ ttlMs, now, records: records.quotes });
    const orders = createOrderStore({ records: records.orders });
    const inventory = createInventory({ holdings });
    const claimed = new Set<string>();
    // deposits are read from wherever the solver's account lives on that chain: the fork in fork
    // mode, the real chain live. a chain with no signer is quotable but nothing can be deposited on it.
    const readers = new Map(chains.flatMap((runtime) => (runtime.fill === null ? [] : [[runtime.chainId, runtime.fill.publicClient] as const])));
    const executor = createExecutor({ quotes, orders, inventory, fillEngines, readers, riskBps, claimed, now });
    const intents = new Map<string, Intent>();

    // what a restart has to know: every order, its intent and its quote, and which deposits are
    // already spoken for. bullmq keeps the jobs; this brings back what the jobs act on. an order
    // that was mid-fill is left where it was and reported, because whether its transaction went
    // out is not knowable from here and paying twice is worse than paying late.
    async function restore(): Promise<{ orders: number; interrupted: string[] }> {
        for (const intent of await records.intents.loadAll()) {
            intents.set(intent.id, intent);
        }

        await quotes.restore();

        const stored = await orders.restore();
        const interrupted: string[] = [];

        for (const order of stored) {
            if (order.deposit !== null) {
                claimed.add(depositKey(order.deposit));
            }

            if (order.state === OrderState.FILLING || order.state === OrderState.REFUNDING) {
                interrupted.push(order.id);
                logger.warn("Order Interrupted: ", { orderId: order.id, state: order.state, fillTx: order.fillTx });
            }
        }

        logger.info("State Restored: ", { orders: stored.length, intents: intents.size, quotes: quotes.size(), interrupted: interrupted.length });

        return { orders: stored.length, interrupted };
    }

    // the amount the user is told to send. two open orders for the same token on the same chain
    // never wait on the same amount: the second is asked for one more base unit, so a transfer
    // matches exactly one order and never needs an order id on chain to say which. the quote was
    // for the intent amount; the extra units stay with the solver.
    function uniqueDepositAmount(chainId: number, token: string, amount: bigint): bigint {
        const open = new Set(
            orders
                .all()
                .filter((order) => order.state === OrderState.AWAITING_DEPOSIT && order.depositWanted !== null)
                .filter((order) => order.depositWanted!.chainId === chainId && isSameAddress(order.depositWanted!.token, token))
                .map((order) => order.depositWanted!.amount),
        );
        let wanted = amount;

        while (open.has(wanted)) {
            wanted += 1n;
        }

        return wanted;
    }

    async function priceIntent(intent: Intent): Promise<PriceOutcome> {
        if (!servesIntent(intent, new Set(environments.keys()), new Set(fillEngines.keys()))) {
            return { ok: false, reason: FailureReason.UNSUPPORTED_CHAIN };
        }

        let best: Path | null;

        const origin = environments.get(intent.origin.chainId)!;
        const destination = environments.get(intent.destination.chainId)!;
        const fillEngine = fillEngines.get(intent.destination.chainId)!;
        const gasForRoute = (legs: PathLeg[], legAmountIn: bigint) => fillEngine.gasForRoute(legs, legAmountIn);

        if (intent.origin.chainId === intent.destination.chainId) {
            const gasPriceWei = await destination.pinnedGasPrice();
            const search = await findPaths({
                sources: destination.sources,
                repository: destination.repository,
                chainId: intent.destination.chainId,
                tokenIn: intent.origin.token,
                tokenOut: intent.destination.token,
                amountIn: intent.origin.amount,
                hubTokens: [...destination.hubTokens],
                readGasPricing: (outputToken: string) => destination.readGasPricing(outputToken, gasPriceWei),
                gasForRoute,
            });

            best = search.best;
        } else {
            // both origin-side costs are transactions on the origin chain. on evm they are measured on
            // the fork. on a chain with no fork they come from the chain's own fee model, which for solana
            // is a per-signature constant. an origin with neither cannot be priced honestly, and the
            // search returns nothing rather than quoting a deposit whose claim cost is unknown.
            const originFillEngine = fillEngines.get(intent.origin.chainId) ?? null;
            const originCosts = origin.originCosts;
            const search = await findBridgedPaths({
                origin,
                destination,
                tokenIn: intent.origin.token,
                tokenOut: intent.destination.token,
                amountIn: intent.origin.amount,
                gasForRoute,
                gasForPayout: (token: Address, amount: bigint) => fillEngine.gasForPayout(token, amount),
                gasForRebalance:
                    originFillEngine !== null
                        ? (legs: PathLeg[], legAmountIn: bigint) => originFillEngine.gasForDeposit(legs, legAmountIn)
                        : originCosts !== null
                          ? () => originCosts.rebalance()
                          : null,
                gasForSettlement:
                    originFillEngine !== null
                        ? (token: Address, amount: bigint) => originFillEngine.gasForPayout(token, amount)
                        : originCosts !== null
                          ? () => originCosts.settlement()
                          : null,
            });

            best = search.best;
        }

        if (best === null) {
            return { ok: false, reason: FailureReason.NO_ROUTES };
        }

        const priced = priceQuote({
            path: best,
            riskBps,
            serviceBps,
            appBps,
            settlementCost: best.bridge?.settlementCostInOutputToken ?? 0n,
            rebalanceCost: best.bridge?.rebalanceCostInOutputToken ?? 0n,
            minAmountOut: intent.minAmountOut,
        });

        if ("reason" in priced) {
            return { ok: false, reason: (priced as PricingRejection).reason };
        }

        // a cross-chain quote is a promise to spend this much destination inventory before the deposit
        // is anywhere near the solver. issuing one it cannot cover and refusing at fill would strand
        // the user's deposit; refuse here instead. a same-chain fill spends the deposit itself.
        if (best.bridge !== null) {
            const spends = best.legs[0]?.tokenIn ?? intent.destination.token;

            if (inventory.balanceOf(intent.destination.chainId, spends).available < best.bridge.bridgedAmount) {
                return { ok: false, reason: FailureReason.SOLVER_BALANCE_TOO_LOW };
            }
        }

        return { ok: true, priced };
    }

    async function quoteIntent(intent: Intent): Promise<QuoteOutcome> {
        let order = await orders.put(createOrder({ id: crypto.randomUUID(), intentId: intent.id, atMs: now() }));
        order = await orders.advance({ orderId: order.id, to: OrderState.QUOTING, atMs: now(), reason: null, quoteId: null });

        if (now() >= intent.deadlineMs) {
            await orders.advance({ orderId: order.id, to: OrderState.QUOTE_FAILED, atMs: now(), reason: FailureReason.ORDER_EXPIRED, quoteId: null });

            return { ok: false, reason: FailureReason.ORDER_EXPIRED };
        }

        const priced = await priceIntent(intent);

        if (!priced.ok) {
            await orders.advance({ orderId: order.id, to: OrderState.QUOTE_FAILED, atMs: now(), reason: priced.reason, quoteId: null });

            return { ok: false, reason: priced.reason };
        }

        await records.intents.save(intent.id, intent);
        intents.set(intent.id, intent);

        const quote = await quotes.put({ intentId: intent.id, priced: priced.priced });

        return {
            ok: true,
            order: await orders.advance({ orderId: order.id, to: OrderState.QUOTED, atMs: now(), reason: null, quoteId: quote.id }),
            quote,
        };
    }

    // accepting pins what the solver will wait for: the exact amount, the address, and the block
    // the transfer must arrive at or after, so a transfer that predates the order can never be
    // mistaken for its deposit. the order leaves here already waiting.
    async function acceptOrder(orderId: string): Promise<AcceptOutcome> {
        const order = orders.get(orderId);

        if (order === null || order.quoteId === null) {
            return { ok: false, reason: FailureReason.QUOTE_NOT_FOUND };
        }

        const intent = intents.get(order.intentId)!;
        const origin = readers.get(intent.origin.chainId);

        // a price for a solana deposit is honest; an order for one is not, because there is no
        // solana address here to receive it at. indicative pricing and executable quotes are two
        // different promises, which is why relay splits /price from /quote.
        if (origin === undefined) {
            return { ok: false, reason: FailureReason.UNSUPPORTED_CHAIN };
        }

        const accepted = await quotes.accept(order.quoteId);

        if (!accepted.ok) {
            if (accepted.reason === FailureReason.ORDER_EXPIRED && order.state === OrderState.QUOTED) {
                await orders.advance({ orderId: order.id, to: OrderState.EXPIRED, atMs: now(), reason: accepted.reason, quoteId: null });
            }

            return { ok: false, reason: accepted.reason };
        }

        const fromBlock = await origin.getBlockNumber({ cacheTime: 0 });

        await orders.advance({ orderId: order.id, to: OrderState.ACCEPTED, atMs: now(), reason: null, quoteId: null });
        await orders.attach(orderId, {
            depositWanted: {
                chainId: intent.origin.chainId,
                token: intent.origin.token as Address,
                amount: uniqueDepositAmount(intent.origin.chainId, intent.origin.token, intent.origin.amount),
                to: depositAddress,
                fromBlock,
            },
        });

        return { ok: true, order: await orders.advance({ orderId, to: OrderState.AWAITING_DEPOSIT, atMs: now(), reason: null, quoteId: null }) };
    }

    async function awaitDeposit(orderId: string) {
        const order = orders.get(orderId);
        const intent = order === null ? undefined : intents.get(order.intentId);

        if (order === null || intent === undefined) {
            throw new Error(`No intent for order ${orderId}`);
        }

        return executor.awaitDeposit(orderId, intent.deadlineMs);
    }

    async function executeOrder(orderId: string): Promise<ExecutionOutcome> {
        const order = orders.get(orderId);
        const intent = order === null ? undefined : intents.get(order.intentId);

        if (intent === undefined) {
            throw new Error(`No intent for order ${orderId}`);
        }

        // an intent's tokens are strings because an origin can be solana; a fill is always evm,
        // because that is the only place the solver can sign, so the destination is an address here
        return executor.execute({
            orderId,
            chainId: intent.destination.chainId,
            recipient: intent.destination.recipient as Address,
            tokenOut: intent.destination.token as Address,
            amountIn: intent.origin.amount,
            deadlineMs: intent.deadlineMs,
        });
    }

    // bring one chain's pool state and gas price up to its head. the block poller calls this on
    // every new block; a test calls it between a fill and the next quote.
    async function sync(chainId: number): Promise<bigint> {
        const source = syncSources.get(chainId);
        const environment = environments.get(chainId);

        if (source === undefined || environment === undefined) {
            throw new Error(`No chain ${chainId} to sync`);
        }

        const head = await source.getBlockNumber({ cacheTime: 0 });
        await environment.sync(source, head);

        return head;
    }

    logger.info("Solver Ready: ", {
        quotes: [...environments.values()].map((environment) => environment.chain.name),
        fills: [...fillEngines.keys()],
        ttlMs,
    });

    return {
        restore,
        priceIntent,
        quoteIntent,
        acceptOrder,
        awaitDeposit,
        settleOrder: (orderId: string) => executor.settle(orderId),
        rebalanceOrder: (orderId: string) => executor.rebalance(orderId),
        sync,
        executeOrder,
        depositAddress,
        environments,
        fillable: new Set(fillEngines.keys()),
        quotes,
        orders,
        inventory,
        intents,
    };
}
