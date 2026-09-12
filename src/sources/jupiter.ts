import { z } from "zod";
import { RPC_TIMEOUT_MS } from "../chain/client";
import { JUPITER_API_KEY, JUPITER_ULTRASWAP_ENDPOINT } from "../lib/config";
import { applyBps } from "../lib/math";
import { type SwapSource } from "./source-registry";

// the order endpoint wants a taker so it can build a transaction. the system program has no funds,
// so the response carries an "insufficient funds" error alongside a perfectly good quote, which is
// all a valuation needs. nothing here is ever executed.
const TAKER_WITH_NOTHING = "11111111111111111111111111111111";

const orderSchema = z.object({
    outAmount: z.string().regex(/^\d+$/),
    feeBps: z.int().nonnegative(),
    router: z.string(),
    gasless: z.boolean(),
    signatureFeeLamports: z.int().nonnegative(),
    prioritizationFeeLamports: z.int().nonnegative(),
    routePlan: z.array(z.object({ swapInfo: z.object({ label: z.string() }) })),
});

// jupiter ultra quotes solana liquidity through its own router. ultra is gasless: the response says
// so and reports zero lamports for signature and priority, taking its cut as feeBps from the swap.
// that is why a solana origin owes no rebalance gas here, and it comes from the api, not from us.
export function createJupiterSource(chainId: number): SwapSource {
    return {
        id: "jupiter",
        kind: "aggregator",
        chainIds: [chainId],

        async quote({ tokenIn, tokenOut, amountIn }) {
            const query = new URLSearchParams({ inputMint: tokenIn, outputMint: tokenOut, amount: amountIn.toString(), taker: TAKER_WITH_NOTHING });
            const response = await fetch(`${JUPITER_ULTRASWAP_ENDPOINT}/order?${query}`, {
                headers: { "x-api-key": JUPITER_API_KEY },
                signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
            });

            if (!response.ok) {
                throw new Error(`jupiter answered ${response.status}`);
            }

            const parsed = orderSchema.safeParse(await response.json());

            if (!parsed.success) {
                return null;
            }

            const order = parsed.data;

            return {
                poolId: `jupiter:${order.router}:${order.routePlan.map((leg) => leg.swapInfo.label).join(">")}`,
                amountOut: BigInt(order.outAmount),
                feeAmount: applyBps({ value: amountIn, bps: BigInt(order.feeBps) }),
            };
        },
    };
}
