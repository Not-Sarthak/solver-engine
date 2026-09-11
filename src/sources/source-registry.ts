import { z } from "zod";
import { logger } from "../lib/logger";

type SwapSourceKind = "dex" | "aggregator" | "rfq" | "wrapper" | "in-house";

export type SwapQuote = {
    sourceId: string;
    poolId: string;
    amountOut: bigint;
    feeAmount: bigint;
    latencyMs: number;
};

export type SourceFailure = {
    sourceId: string;
    reason: string;
    latencyMs: number;
};

type QuoteRound = {
    quotes: SwapQuote[];
    failures: SourceFailure[];
};

export type SwapSource = {
    id: string;
    kind: SwapSourceKind;
    chainIds: readonly number[];
    quote(params: QuoteParams): Promise<Omit<SwapQuote, "sourceId" | "latencyMs"> | null>;
};

// token addresses are not hex everywhere: solana is base58, bitcoin is bech32. anything that
// constrains this to 0x-prefixed 20 bytes breaks the moment a non-evm chain is registered.
const quoteParamsSchema = z.object({
    chainId: z.int().positive(),
    tokenIn: z.string().min(1),
    tokenOut: z.string().min(1),
    amountIn: z.bigint().positive(),
});

export type QuoteParams = z.infer<typeof quoteParamsSchema>;

// true when tokenIn is the pool"s token0, false when it is token1, null when the pool does not
// serve the pair at all. clmm calls this zeroForOne; cpmm uses it to orient the reserves.
export function tokenInIsToken0(pool: { token0: string; token1: string }, tokenIn: string, tokenOut: string): boolean | null {
    const token0 = pool.token0.toLowerCase();
    const token1 = pool.token1.toLowerCase();
    const from = tokenIn.toLowerCase();
    const to = tokenOut.toLowerCase();

    if (token0 === from && token1 === to) {
        return true;
    }

    if (token1 === from && token0 === to) {
        return false;
    }

    return null;
}

export function createSourceRegistry(sources: readonly SwapSource[]) {
    const byId = new Map<string, SwapSource>();

    for (const source of sources) {
        if (byId.has(source.id)) {
            throw new Error(`Duplicate swap source id: ${source.id}`);
        }

        byId.set(source.id, source);
    }

    function list(): readonly SwapSource[] {
        return [...byId.values()];
    }

    function forChain(chainId: number): readonly SwapSource[] {
        return list().filter((source) => source.chainIds.includes(chainId));
    }

    async function quoteAll(params: QuoteParams): Promise<QuoteRound> {
        quoteParamsSchema.parse(params);

        const candidates = forChain(params.chainId);
        // a source that throws is a failure to record, not a reason to abandon the round
        const settled = await Promise.all(
            candidates.map(async (source): Promise<SwapQuote | SourceFailure | null> => {
                const startedAt = Bun.nanoseconds();
                const latencyMs = () => Number(((Bun.nanoseconds() - startedAt) / 1_000_000).toFixed(3));

                try {
                    const quoted = await source.quote(params);

                    return quoted === null ? null : { ...quoted, sourceId: source.id, latencyMs: latencyMs() };
                } catch (error) {
                    return { sourceId: source.id, reason: error instanceof Error ? error.message : String(error), latencyMs: latencyMs() };
                }
            }),
        );

        const quotes = settled.filter((result): result is SwapQuote => result !== null && "amountOut" in result);
        const failures = settled.filter((result): result is SourceFailure => result !== null && "reason" in result);

        logger.info("Quoted Sources: ", {
            chainId: params.chainId,
            asked: candidates.length,
            quoted: quotes.length,
            failed: failures.length,
            latencyMs: Object.fromEntries([...quotes, ...failures].map((result) => [result.sourceId, result.latencyMs])),
        });

        return { quotes, failures };
    }

    return { list, forChain, quoteAll };
}
