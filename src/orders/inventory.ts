import { z } from "zod";
import type { Holding } from "../chain/funding";
import { FailureReason } from "./failures";
import { logger } from "../lib/logger";
import type { Records } from "./records";

export type Balance = {
    available: bigint;
    reserved: bigint;
};

type ReservationState = "held" | "committed" | "released";

export type Reservation = {
    orderId: string;
    chainId: number;
    token: string;
    amount: bigint;
    state: ReservationState;
};

type ReservationResult = { ok: true; reservation: Reservation } | { ok: false; reason: FailureReason };

// a balance as it is stored: the key names the chain and token so a row can be read back alone
export type StoredBalance = Balance & { chainId: number; token: string };

type InventoryParams = { holdings: readonly Holding[]; records: { balances: Records<StoredBalance>; reservations: Records<Reservation> } };

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

export function createInventory({ holdings, records }: InventoryParams) {
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

    // every change is in memory first and in the store before the caller sees it. the in-memory
    // step is what keeps a check and its mutation together; the store is what survives a restart.
    async function setBalance(chainId: number, token: string, balance: Balance): Promise<Balance> {
        balances.set(balanceKey(chainId, token), balance);
        await records.balances.save(balanceKey(chainId, token), { chainId, token, ...balance });

        return balance;
    }

    async function setReservation(reservation: Reservation): Promise<Reservation> {
        reservations.set(reservation.orderId, reservation);
        await records.reservations.save(reservation.orderId, reservation);

        return reservation;
    }

    // what was stored is the ledger a previous process left. the balances given at boot are what
    // the chain says now, and the chain wins: each stored token is re-based on it, keeping only
    // the reservations, which are promises the chain knows nothing about.
    async function restore(): Promise<{ balances: number; reservations: number }> {
        const storedReservations = await records.reservations.loadAll();
        const storedBalances = await records.balances.loadAll();

        for (const reservation of storedReservations) {
            reservations.set(reservation.orderId, reservation);
        }

        for (const stored of storedBalances) {
            const onChain = balances.get(balanceKey(stored.chainId, stored.token));
            const held = [...reservations.values()]
                .filter((r) => r.state === "held" && r.chainId === stored.chainId && r.token === stored.token)
                .reduce((sum, r) => sum + r.amount, 0n);

            // a token the chain was not asked about keeps its stored ledger; one it was is re-based
            const available = onChain === undefined ? stored.available : onChain.available - held;
            balances.set(balanceKey(stored.chainId, stored.token), { available, reserved: held });
        }

        return { balances: storedBalances.length, reservations: storedReservations.length };
    }

    // deliberately synchronous end to end. javascript runs this to completion before any other
    // reservation can interleave, so the check and the mutation cannot be split by an await. a lock
    // would buy nothing here; a second process would, which is a different problem.
    async function reserve(params: ReserveParams): Promise<ReservationResult> {
        const { orderId, chainId, token, amount } = reserveSchema.parse(params);

        const existing = reservations.get(orderId);

        // an order reserves twice when its swap went through and only the payout is retried: the
        // first reservation was the input and is spent, the second is the output it now holds
        if (existing !== undefined && existing.state === "held") {
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

        await setBalance(chainId, token, { available: balance.available - amount, reserved: balance.reserved + amount });

        return { ok: true, reservation: await setReservation({ orderId, chainId, token, amount, state: "held" }) };
    }

    async function settle(orderId: string, state: Exclude<ReservationState, "held">): Promise<Reservation> {
        const reservation = reservations.get(orderId);

        if (reservation === undefined) {
            throw new Error(`No reservation for order ${orderId}`);
        }

        if (reservation.state !== "held") {
            return reservation;
        }

        const key = balanceKey(reservation.chainId, reservation.token);
        const balance = balances.get(key)!;

        await setBalance(reservation.chainId, reservation.token, {
            available: state === "released" ? balance.available + reservation.amount : balance.available,
            reserved: balance.reserved - reservation.amount,
        });

        return setReservation({ ...reservation, state });
    }

    async function credit({ chainId, token, amount }: z.infer<typeof holdingSchema>): Promise<Balance> {
        holdingSchema.parse({ chainId, token, amount });

        const balance = balanceOf(chainId, token);

        return setBalance(chainId, token, { ...balance, available: balance.available + amount });
    }

    // what left the account outside a reservation: a swap's input, a payout. it is simply gone, and
    // the ledger has to say so or the solver believes it still holds it.
    async function debit({ chainId, token, amount }: z.infer<typeof holdingSchema>): Promise<Balance> {
        const current = balanceOf(chainId, token);

        return setBalance(chainId, token, { available: current.available - amount, reserved: current.reserved });
    }

    // live, the chain is the source of truth and the in-process ledger is a cache of it. after a fill
    // the two are aligned from what the account actually holds, so drift cannot accumulate across
    // fills the way it silently would if only the arithmetic here were trusted.
    async function reconcile(chainId: number, token: string, onChain: bigint): Promise<Balance> {
        const current = balanceOf(chainId, token);
        const balance = { available: onChain - current.reserved, reserved: current.reserved };

        if (balance.available !== current.available) {
            logger.warn("Inventory Reconciled: ", { chainId, token, ledger: current.available.toString(), chain: onChain.toString() });
        }

        return balance.available === current.available ? current : setBalance(chainId, token, balance);
    }

    // every token this ledger has a row for on a chain, for a periodic check against the chain
    function tokensOn(chainId: number): string[] {
        return [...balances.keys()].filter((key) => key.startsWith(`${chainId}:`)).map((key) => key.slice(key.indexOf(":") + 1));
    }

    function snapshot(): Record<string, Balance> {
        return Object.fromEntries(balances);
    }

    return {
        balanceOf,
        hasReservation: (orderId: string) => reservations.get(orderId)?.state === "held",
        restore,
        reserve,
        commit: (orderId: string) => settle(orderId, "committed"),
        release: (orderId: string) => settle(orderId, "released"),
        credit,
        debit,
        reconcile,
        tokensOn,
        snapshot,
    };
}
