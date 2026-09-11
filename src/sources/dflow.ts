import { z } from "zod";
import { RPC_TIMEOUT_MS } from "../chain/client";
import { DFLOW_API_KEY, DFLOW_QUOTE_ENDPOINT } from "../lib/config";
import { type SwapSource } from "./source-registry";

const quoteSchema = z.object({
    outAmount: z.string().regex(/^\d+$/),
    platformFee: z.object({ amount: z.string().regex(/^\d+$/) }).nullable(),
    routePlan: z.array(z.object({ venue: z.string() })),
    simulatedComputeUnits: z.int().nonnegative().nullable(),
});

// dflow is a second, independent solana router. two routers that agree within a few basis points
// are evidence the price is real; one router alone is a number.
export function createDflowSource(chainId: number): SwapSource {
    return {
        id: "dflow",
        kind: "aggregator",
        chainIds: [chainId],

        async quote({ tokenIn, tokenOut, amountIn }) {
            const query = new URLSearchParams({ inputMint: tokenIn, outputMint: tokenOut, amount: amountIn.toString() });
            const response = await fetch(`${DFLOW_QUOTE_ENDPOINT}/quote?${query}`, {
                headers: { "x-api-key": DFLOW_API_KEY },
                signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
            });

            if (!response.ok) {
                throw new Error(`dflow answered ${response.status}`);
            }

            const parsed = quoteSchema.safeParse(await response.json());

            if (!parsed.success) {
                return null;
            }

            const quote = parsed.data;

            return {
                poolId: `dflow:${quote.routePlan.map((leg) => leg.venue).join(">")}`,
                amountOut: BigInt(quote.outAmount),
                feeAmount: quote.platformFee === null ? 0n : BigInt(quote.platformFee.amount),
            };
        },
    };
}
