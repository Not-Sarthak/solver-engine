import { z } from "zod";
import { BPS_DENOMINATOR, mulDiv } from "../lib/math";
import { applyBps } from "../lib/math";
import { tokenInIsToken0, type QuoteParams, type SwapSource } from "./source-registry";

type CpmmPool = { id: string; chainId: number; token0: string; token1: string; reserve0: bigint; reserve1: bigint; feeBps: bigint };

type CpmmSourceParams = { id: string; chainIds: readonly number[]; readPools: () => readonly CpmmPool[] };

const reserveSchema = z.bigint().positive();

const feeBpsSchema = z.bigint().nonnegative().lt(BPS_DENOMINATOR);

const constantProductSchema = {
    getAmountOut: z.object({
        amountIn: z.bigint().positive(),
        reserveIn: reserveSchema,
        reserveOut: reserveSchema,
        feeBps: feeBpsSchema,
    }),
} as const;

type GetAmountOutParams = z.infer<typeof constantProductSchema.getAmountOut>;

function getAmountOut(params: GetAmountOutParams): bigint {
    const { amountIn, reserveIn, reserveOut, feeBps } = constantProductSchema.getAmountOut.parse(params);

    const amountInAfterFee = amountIn * (BPS_DENOMINATOR - feeBps);

    return mulDiv({
        value: amountInAfterFee,
        multiplier: reserveOut,
        denominator: reserveIn * BPS_DENOMINATOR + amountInAfterFee,
    });
}

export function createCpmmSource({ id, chainIds, readPools }: CpmmSourceParams): SwapSource {
    return {
        id,
        kind: "dex",
        chainIds,

        async quote({ chainId, tokenIn, tokenOut, amountIn }: QuoteParams) {
            let best = null as { poolId: string; amountOut: bigint; feeAmount: bigint } | null;

            for (const pool of readPools()) {
                if (pool.chainId !== chainId) {
                    continue;
                }

                const forward = tokenInIsToken0(pool, tokenIn, tokenOut);

                if (forward === null) {
                    continue;
                }

                const [reserveIn, reserveOut] = forward ? [pool.reserve0, pool.reserve1] : [pool.reserve1, pool.reserve0];
                const amountOut = getAmountOut({ amountIn, reserveIn, reserveOut, feeBps: pool.feeBps });

                if (best === null || amountOut > best.amountOut) {
                    best = { poolId: pool.id, amountOut, feeAmount: applyBps({ value: amountIn, bps: pool.feeBps }) };
                }
            }

            return best;
        },
    };
}
