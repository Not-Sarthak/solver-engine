import { FailureReason } from "./failures";
import { logger } from "../lib/logger";
import { type PricedQuote } from "../quoting/pricing";
import type { Records } from "./records";

type QuoteStatus = "open" | "accepted" | "expired";

export type StoredQuote = PricedQuote & {
    id: string;
    intentId: string;
    createdAtMs: number;
    expiresAtMs: number;
    acceptedAtMs: number | null;
};

type AcceptResult = { ok: true; quote: StoredQuote } | { ok: false; reason: FailureReason };

type QuoteStoreParams = { ttlMs: number; now: () => number; records: Records<StoredQuote> };

type PutQuoteParams = { intentId: string; priced: PricedQuote };

export function createQuoteStore({ ttlMs, now, records }: QuoteStoreParams) {
    const quotes = new Map<string, StoredQuote>();

    async function restore(): Promise<number> {
        const stored = await records.loadAll();

        for (const quote of stored) {
            quotes.set(quote.id, quote);
        }

        return stored.length;
    }

    // expiry is derived from the clock on every read rather than written into the record, so a quote
    // cannot be left in a stale "open" state by a process that died before it could mark it.
    function statusOf(quote: StoredQuote): QuoteStatus {
        if (quote.acceptedAtMs !== null) {
            return "accepted";
        }

        return now() >= quote.expiresAtMs ? "expired" : "open";
    }

    async function put({ intentId, priced }: PutQuoteParams): Promise<StoredQuote> {
        const createdAtMs = now();
        const quote: StoredQuote = {
            ...priced,
            id: crypto.randomUUID(),
            intentId,
            createdAtMs,
            expiresAtMs: createdAtMs + ttlMs,
            acceptedAtMs: null,
        };

        await records.save(quote.id, quote);
        quotes.set(quote.id, quote);

        logger.info("Quote Issued: ", {
            quoteId: quote.id,
            intentId,
            route: priced.path.legs.map((leg) => leg.quote.sourceId).join(" -> "),
            quotedAmountOut: priced.quotedAmountOut.toString(),
            expectedProfit: priced.expectedProfit.toString(),
            expiresInMs: ttlMs,
        });

        return quote;
    }

    function get(quoteId: string): { quote: StoredQuote; status: QuoteStatus } | null {
        const quote = quotes.get(quoteId);

        return quote === undefined ? null : { quote, status: statusOf(quote) };
    }

    async function accept(quoteId: string): Promise<AcceptResult> {
        const found = quotes.get(quoteId);

        if (found === undefined) {
            return { ok: false, reason: FailureReason.QUOTE_NOT_FOUND };
        }

        const status = statusOf(found);

        if (status === "accepted") {
            return { ok: false, reason: FailureReason.ORDER_ALREADY_FILLED };
        }

        if (status === "expired") {
            logger.warn("Quote Expired: ", { quoteId, intentId: found.intentId, ageMs: now() - found.createdAtMs, ttlMs });

            return { ok: false, reason: FailureReason.ORDER_EXPIRED };
        }

        const accepted = { ...found, acceptedAtMs: now() };
        await records.save(quoteId, accepted);
        quotes.set(quoteId, accepted);

        return { ok: true, quote: accepted };
    }

    // nothing evicts on its own: a timer is infrastructure, and redis would do this with a key ttl.
    function purgeExpired(): number {
        const before = quotes.size;

        for (const [id, quote] of quotes) {
            if (statusOf(quote) === "expired") {
                quotes.delete(id);
            }
        }

        return before - quotes.size;
    }

    return { put, get, accept, restore, purgeExpired, size: () => quotes.size };
}
