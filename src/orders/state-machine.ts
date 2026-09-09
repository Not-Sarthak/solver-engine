import type { Address, Hash } from "viem";
import type { Records } from "./records";
import type { Deposit } from "../chain/deposits";
import type { FailureReason } from "./failures";
import { logger } from "../lib/logger";

type Transition = {
    from: OrderState;
    to: OrderState;
    atMs: number;
    reason: FailureReason | null;
};

// what the solver is waiting to receive, fixed at accept: the token and amount on the origin chain,
// sent to the solver's own address, in a block at or after the one the order was accepted in
type DepositWanted = {
    chainId: number;
    token: Address;
    amount: bigint;
    to: Address;
    fromBlock: bigint;
    deadlineMs: number;
    // where a refund goes. the user names it at quote time; otherwise it is whoever sent the
    // deposit, which is wrong when a router or a smart wallet sent it on the user's behalf.
    refundTo: Address | null;
};

// what a refund sends when it is not the deposit: a same-chain swap that landed under the quote
// has already turned the deposit into the output token, and that is what the user gets back
export type Owed = { chainId: number; token: Address; amount: bigint };

export type Order = {
    id: string;
    intentId: string;
    quoteId: string | null;
    state: OrderState;
    failureReason: FailureReason | null;
    // what the chain or the rpc actually said, for the failure the reason classifies
    failureDetail: string | null;
    history: readonly Transition[];
    depositWanted: DepositWanted | null;
    deposit: Deposit | null;
    // the transaction that paid the user, once there is one
    fillTx: Hash | null;
    // the transaction that gave the deposit back, once there is one
    refundTx: Hash | null;
    // the destination block the fill was started at, so a fill this process never saw finish can
    // be looked for on chain after a restart
    fillFromBlock: bigint | null;
    owed: Owed | null;
};

type CreateOrderParams = { id: string; intentId: string; atMs: number };

type TransitionParams = { order: Order; to: OrderState; atMs: number; reason: FailureReason | null; quoteId: string | null; detail?: string };

export const OrderState = {
    RECEIVED: "RECEIVED",
    QUOTING: "QUOTING",
    QUOTED: "QUOTED",
    ACCEPTED: "ACCEPTED",
    AWAITING_DEPOSIT: "AWAITING_DEPOSIT",
    DEPOSIT_CONFIRMED: "DEPOSIT_CONFIRMED",
    FILLING: "FILLING",
    FILLED: "FILLED",
    SETTLING: "SETTLING",
    SETTLED: "SETTLED",
    REFUNDING: "REFUNDING",
    REFUNDED: "REFUNDED",
    REFUND_FAILED: "REFUND_FAILED",
    EXPIRED: "EXPIRED",
    CANCELLED: "CANCELLED",
    QUOTE_FAILED: "QUOTE_FAILED",
    FILL_FAILED: "FILL_FAILED",
    PAYOUT_FAILED: "PAYOUT_FAILED",
    SETTLEMENT_FAILED: "SETTLEMENT_FAILED",
    INSUFFICIENT_INVENTORY: "INSUFFICIENT_INVENTORY",
    DEPOSIT_REORGED: "DEPOSIT_REORGED",
    // a transaction may or may not have gone out and the chain does not say: a person decides
    NEEDS_REVIEW: "NEEDS_REVIEW",
} as const;

export type OrderState = (typeof OrderState)[keyof typeof OrderState];

// every order waits for its deposit. a same-chain order is not exempt: the user still has to send
// the input before the solver swaps it, and paying out first would be the solver fronting a swap
// it was never paid for.
const TRANSITIONS: Record<OrderState, readonly OrderState[]> = {
    RECEIVED: [OrderState.QUOTING, OrderState.CANCELLED],
    QUOTING: [OrderState.QUOTED, OrderState.QUOTE_FAILED, OrderState.CANCELLED],
    QUOTED: [OrderState.ACCEPTED, OrderState.EXPIRED, OrderState.CANCELLED],
    ACCEPTED: [OrderState.AWAITING_DEPOSIT, OrderState.EXPIRED, OrderState.CANCELLED],
    AWAITING_DEPOSIT: [OrderState.DEPOSIT_CONFIRMED, OrderState.EXPIRED, OrderState.CANCELLED],
    DEPOSIT_CONFIRMED: [OrderState.FILLING, OrderState.INSUFFICIENT_INVENTORY, OrderState.CANCELLED],
    FILLING: [OrderState.FILLED, OrderState.FILL_FAILED, OrderState.PAYOUT_FAILED, OrderState.REFUNDING, OrderState.NEEDS_REVIEW],
    // the swap went through and the payout did not: the output is held, so only the payout is
    // retried, never the swap
    PAYOUT_FAILED: [OrderState.FILLING],
    // a deposit the solver holds and did not fill against is the user's, whatever stopped the fill.
    // these carry the reason the fill did not happen and then go back through the refund path.
    FILL_FAILED: [OrderState.REFUNDING],
    INSUFFICIENT_INVENTORY: [OrderState.REFUNDING],
    // expired with no deposit is the end; expired with a late one is a refund
    EXPIRED: [OrderState.REFUNDING],
    FILLED: [OrderState.SETTLING],
    // settlement is where a reorg is noticed: the deposit that paid for the fill is re-checked
    SETTLING: [OrderState.SETTLED, OrderState.SETTLEMENT_FAILED, OrderState.DEPOSIT_REORGED],
    // a refund is a transaction, and a transaction can fail to send. the deposit is still held, so
    // the retry is the recovery, the same way settlement is retried.
    REFUNDING: [OrderState.REFUNDED, OrderState.REFUND_FAILED, OrderState.NEEDS_REVIEW],
    REFUND_FAILED: [OrderState.REFUNDING],
    // the user has been paid and we have not: retrying settlement is the recovery, so this is the
    // one failure state that is not terminal.
    SETTLEMENT_FAILED: [OrderState.SETTLING],
    SETTLED: [],
    REFUNDED: [],
    CANCELLED: [],
    QUOTE_FAILED: [],
    DEPOSIT_REORGED: [],
    NEEDS_REVIEW: [],
};

const FAILURE_STATES = new Set<OrderState>([
    OrderState.QUOTE_FAILED,
    OrderState.EXPIRED,
    OrderState.CANCELLED,
    OrderState.FILL_FAILED,
    OrderState.PAYOUT_FAILED,
    OrderState.SETTLEMENT_FAILED,
    OrderState.REFUND_FAILED,
    OrderState.INSUFFICIENT_INVENTORY,
    OrderState.DEPOSIT_REORGED,
    OrderState.NEEDS_REVIEW,
]);

// relay exposes eight statuses on /intents/status/v3; our finer internal states map onto them so
// a client sees the same vocabulary it would from the real api.
const PUBLIC_STATUS: Record<OrderState, string> = {
    RECEIVED: "waiting",
    QUOTING: "waiting",
    QUOTED: "waiting",
    ACCEPTED: "waiting",
    AWAITING_DEPOSIT: "waiting",
    DEPOSIT_CONFIRMED: "depositing",
    FILLING: "pending",
    FILLED: "submitted",
    SETTLING: "submitted",
    SETTLED: "success",
    REFUNDING: "refund",
    REFUNDED: "refund",
    REFUND_FAILED: "delayed",
    EXPIRED: "failure",
    CANCELLED: "failure",
    QUOTE_FAILED: "failure",
    FILL_FAILED: "refund",
    PAYOUT_FAILED: "delayed",
    SETTLEMENT_FAILED: "delayed",
    INSUFFICIENT_INVENTORY: "refund",
    DEPOSIT_REORGED: "failure",
    NEEDS_REVIEW: "delayed",
};

export function publicStatusOf(state: OrderState): string {
    return PUBLIC_STATUS[state];
}

export function isTerminal(state: OrderState): boolean {
    return TRANSITIONS[state].length === 0;
}

function canTransition(from: OrderState, to: OrderState): boolean {
    return TRANSITIONS[from].includes(to);
}

export function createOrder({ id, intentId, atMs }: CreateOrderParams): Order {
    return {
        id,
        intentId,
        quoteId: null,
        state: OrderState.RECEIVED,
        failureReason: null,
        failureDetail: null,
        history: [{ from: OrderState.RECEIVED, to: OrderState.RECEIVED, atMs, reason: null }],
        depositWanted: null,
        deposit: null,
        fillTx: null,
        refundTx: null,
        fillFromBlock: null,
        owed: null,
    };
}

function transition({ order, to, atMs, reason, quoteId, detail }: TransitionParams): Order {
    if (!canTransition(order.state, to)) {
        throw new Error(`Invalid order transition ${order.state} -> ${to} for order ${order.id}`);
    }

    if (FAILURE_STATES.has(to) && reason === null) {
        throw new Error(`Transition to ${to} requires a failure reason for order ${order.id}`);
    }

    const moved: Order = {
        ...order,
        quoteId: quoteId ?? order.quoteId,
        state: to,
        failureReason: reason,
        failureDetail: detail ?? null,
        history: [...order.history, { from: order.state, to, atMs, reason }],
    };

    logger.info("Order Transition: ", { orderId: order.id, from: order.state, to, reason, detail: detail ?? null, terminal: isTerminal(to) });

    return moved;
}

// every write lands in the record store before the caller sees it, so a crash between two
// transitions loses nothing that was reported. reads are from memory: this process is the only
// writer, and the map is the cache of what it wrote.
export function createOrderStore({ records }: { records: Records<Order> }) {
    const orders = new Map<string, Order>();

    async function put(order: Order): Promise<Order> {
        await records.save(order.id, order);
        orders.set(order.id, order);

        return order;
    }

    async function restore(): Promise<Order[]> {
        const stored = await records.loadAll();

        for (const order of stored) {
            orders.set(order.id, order);
        }

        return stored;
    }

    function get(orderId: string): Order | null {
        return orders.get(orderId) ?? null;
    }

    // always from the stored record, never from a snapshot the caller holds: a snapshot taken before
    // a fact was attached would carry the transition and drop the fact
    async function advance({ orderId, ...params }: Omit<TransitionParams, "order"> & { orderId: string }): Promise<Order> {
        const order = orders.get(orderId);

        if (order === undefined) {
            throw new Error(`No order ${orderId}`);
        }

        return put(transition({ order, ...params }));
    }

    // facts attached outside the state machine: what is awaited, and what arrived
    async function attach(
        orderId: string,
        facts: Partial<Pick<Order, "depositWanted" | "deposit" | "fillTx" | "refundTx" | "fillFromBlock" | "owed">>,
    ): Promise<Order> {
        const order = orders.get(orderId);

        if (order === undefined) {
            throw new Error(`No order ${orderId}`);
        }

        return put({ ...order, ...facts });
    }

    return { put, get, advance, attach, restore, size: () => orders.size, all: () => [...orders.values()] };
}
