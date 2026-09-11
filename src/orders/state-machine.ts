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
type DepositWanted = { chainId: number; token: Address; amount: bigint; to: Address; fromBlock: bigint };

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
    EXPIRED: "EXPIRED",
    CANCELLED: "CANCELLED",
    QUOTE_FAILED: "QUOTE_FAILED",
    FILL_FAILED: "FILL_FAILED",
    SETTLEMENT_FAILED: "SETTLEMENT_FAILED",
    INSUFFICIENT_INVENTORY: "INSUFFICIENT_INVENTORY",
    DEPOSIT_REORGED: "DEPOSIT_REORGED",
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
    FILLING: [OrderState.FILLED, OrderState.FILL_FAILED, OrderState.REFUNDING],
    FILLED: [OrderState.SETTLING],
    // settlement is where a reorg is noticed: the deposit that paid for the fill is re-checked
    SETTLING: [OrderState.SETTLED, OrderState.SETTLEMENT_FAILED, OrderState.DEPOSIT_REORGED],
    REFUNDING: [OrderState.REFUNDED, OrderState.FILL_FAILED],
    // the user has been paid and we have not: retrying settlement is the recovery, so this is the
    // one failure state that is not terminal.
    SETTLEMENT_FAILED: [OrderState.SETTLING],
    SETTLED: [],
    REFUNDED: [],
    EXPIRED: [],
    CANCELLED: [],
    QUOTE_FAILED: [],
    FILL_FAILED: [],
    INSUFFICIENT_INVENTORY: [],
    DEPOSIT_REORGED: [],
};

const FAILURE_STATES = new Set<OrderState>([
    OrderState.QUOTE_FAILED,
    OrderState.EXPIRED,
    OrderState.CANCELLED,
    OrderState.FILL_FAILED,
    OrderState.SETTLEMENT_FAILED,
    OrderState.INSUFFICIENT_INVENTORY,
    OrderState.DEPOSIT_REORGED,
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
    EXPIRED: "failure",
    CANCELLED: "failure",
    QUOTE_FAILED: "failure",
    FILL_FAILED: "failure",
    SETTLEMENT_FAILED: "delayed",
    INSUFFICIENT_INVENTORY: "failure",
    DEPOSIT_REORGED: "failure",
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
    function advance({ orderId, ...params }: Omit<TransitionParams, "order"> & { orderId: string }): Promise<Order> {
        const order = orders.get(orderId);

        if (order === undefined) {
            throw new Error(`No order ${orderId}`);
        }

        return put(transition({ order, ...params }));
    }

    // facts attached outside the state machine: what is awaited, and what arrived
    function attach(orderId: string, facts: Partial<Pick<Order, "depositWanted" | "deposit" | "fillTx">>): Promise<Order> {
        const order = orders.get(orderId);

        if (order === undefined) {
            throw new Error(`No order ${orderId}`);
        }

        return put({ ...order, ...facts });
    }

    return { put, get, advance, attach, restore, size: () => orders.size, all: () => [...orders.values()] };
}
