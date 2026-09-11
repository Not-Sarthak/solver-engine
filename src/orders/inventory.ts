import { z } from "zod";
import type { Holding } from "../chain/funding";
import { FailureReason } from "./failures";
import { logger } from "../lib/logger";

export type Balance = {
    available: bigint;
    reserved: bigint;
};

type ReservationState = "held" | "committed" | "released";

type Reservation = {
    orderId: string;
    chainId: number;
    token: string;
    amount: bigint;
    state: ReservationState;
};

type ReservationResult = { ok: true; reservation: Reservation } | { ok: false; reason: FailureReason };

type InventoryParams = { holdings: readonly Holding[] };

type ReserveParams = z.infer<typeof reserveSchema>;

const holdingSchema = z.object({
    chainId: z.int().positive(),
    token: z.string().min(1),
    amount: z.bigint().nonnegative(),
});

export const reserveSchema = z.object({
    orderId: z.string().min(1),
    chainId: z.int().positive(),
    token: z.string().min(1),
    amount: z.bigint().positive(),
});

function balanceKey(chainId: number, token: string): string {
    return `${chainId}:${token}`;
}

export function createInventory({ holdings }: InventoryParams) {
    const balances = new Map<string, Balance>();
    const reservations = new Map<string, Reservation>();

    for (const holding of holdings) {
        const key = balanceKey(holding.chainId, holding.token);
        const existing = balances.get(key) ?? { available: 0n, reserved: 0n };

        balances.set(key, { ...existing, available: existing.available + holding.amount });
    }

    function balanceOf(chainId: number, token: string): Balance {
        return balances.get(balanceKey(chainId, token)) ?? { available: 0n, reserved: 0n };
    }

    // deliberately synchronous end to end. javascript runs this to completion before any other
    // reservation can interleave, so the check and the mutation cannot be split by an await. a lock
    // would buy nothing here; a second process would, which is a different problem.
    function reserve(params: ReserveParams): ReservationResult {
        const { orderId, chainId, token, amount } = reserveSchema.parse(params);

        const existing = reservations.get(orderId);

        if (existing !== undefined) {
            if (existing.amount !== amount || existing.chainId !== chainId || existing.token !== token) {
                throw new Error(`Order ${orderId} already reserved a different amount or asset`);
            }

            return { ok: true, reservation: existing };
        }

        const key = balanceKey(chainId, token);
        const balance = balances.get(key) ?? { available: 0n, reserved: 0n };

        if (balance.available < amount) {
            logger.warn("Reservation Refused: ", { orderId, chainId, token, wanted: amount.toString(), available: balance.available.toString() });

            return { ok: false, reason: FailureReason.SOLVER_BALANCE_TOO_LOW };
        }

        balances.set(key, { available: balance.available - amount, reserved: balance.reserved + amount });

        const reservation: Reservation = { orderId, chainId, token, amount, state: "held" };
        reservations.set(orderId, reservation);

        return { ok: true, reservation };
    }

    function settle(orderId: string, state: Exclude<ReservationState, "held">): Reservation {
        const reservation = reservations.get(orderId);

        if (reservation === undefined) {
            throw new Error(`No reservation for order ${orderId}`);
        }

        if (reservation.state !== "held") {
            return reservation;
        }

        const key = balanceKey(reservation.chainId, reservation.token);
        const balance = balances.get(key)!;

        balances.set(key, {
            available: state === "released" ? balance.available + reservation.amount : balance.available,
            reserved: balance.reserved - reservation.amount,
        });

        const updated = { ...reservation, state };
        reservations.set(orderId, updated);

        return updated;
    }

    function credit({ chainId, token, amount }: z.infer<typeof holdingSchema>): Balance {
        holdingSchema.parse({ chainId, token, amount });

        const key = balanceKey(chainId, token);
        const balance = balances.get(key) ?? { available: 0n, reserved: 0n };
        const updated = { ...balance, available: balance.available + amount };

        balances.set(key, updated);

        return updated;
    }

    // what left the account outside a reservation: a swap's input, a payout. it is simply gone, and
    // the ledger has to say so or the solver believes it still holds it.
    function debit({ chainId, token, amount }: z.infer<typeof holdingSchema>): Balance {
        const key = balanceKey(chainId, token);
        const current = balances.get(key) ?? { available: 0n, reserved: 0n };
        const balance = { available: current.available - amount, reserved: current.reserved };

        balances.set(key, balance);

        return balance;
    }

    // live, the chain is the source of truth and the in-process ledger is a cache of it. after a fill
    // the two are aligned from what the account actually holds, so drift cannot accumulate across
    // fills the way it silently would if only the arithmetic here were trusted.
    function reconcile(chainId: number, token: string, onChain: bigint): Balance {
        const key = balanceKey(chainId, token);
        const current = balances.get(key) ?? { available: 0n, reserved: 0n };
        const balance = { available: onChain - current.reserved, reserved: current.reserved };

        if (balance.available !== current.available) {
            logger.warn("Inventory Reconciled: ", { chainId, token, ledger: current.available.toString(), chain: onChain.toString() });
        }

        balances.set(key, balance);

        return balance;
    }

    function snapshot(): Record<string, Balance> {
        return Object.fromEntries(balances);
    }

    return {
        balanceOf,
        reserve,
        commit: (orderId: string) => settle(orderId, "committed"),
        release: (orderId: string) => settle(orderId, "released"),
        credit,
        debit,
        reconcile,
        snapshot,
    };
}
