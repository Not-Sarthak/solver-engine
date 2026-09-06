import { z } from "zod";
import { mulDiv, mulDivRoundingUp } from "../lib/math";
import { tokenInIsToken0, type QuoteParams, type SwapSource } from "./source-registry";

type SwapStep = {
    sqrtRatioNextX96: bigint;
    amountIn: bigint;
    amountOut: bigint;
    feeAmount: bigint;
};

type SwapResult = {
    amountIn: bigint;
    amountOut: bigint;
    feeAmount: bigint;
    exhaustedTicks: boolean;
    sqrtPriceX96After: bigint;
    tickAfter: number;
    liquidityAfter: bigint;
    ticksCrossed: number;
};

type ClmmPool = { id: string; chainId: number; token0: string; token1: string; state: ConcentratedPool };

type ClmmSourceParams = { id: string; chainIds: readonly number[]; readPools: () => readonly ClmmPool[] };

const Q96 = 2n ** 96n;

// v3 states fees in millionths, not basis points
const FEE_PIPS_DENOMINATOR = 1_000_000n;

const MIN_TICK = -887272;

const MAX_TICK = 887272;

const MIN_SQRT_RATIO = 4295128739n;

const MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342n;

const UINT256_MAX = 2n ** 256n - 1n;

const Q128 = 2n ** 128n;

// 1.0001^(2^i / 2) in Q128.128, one per bit of |tick|. squaring by bit decomposition
// avoids any exponentiation at runtime, which is why v3 stores them rather than computing.
const TICK_RATIOS = [
    0xfffcb933bd6fad37aa2d162d1a594001n,
    0xfff97272373d413259a46990580e213an,
    0xfff2e50f5f656932ef12357cf3c7fdccn,
    0xffe5caca7e10e4e61c3624eaa0941cd0n,
    0xffcb9843d60f6159c9db58835c926644n,
    0xff973b41fa98c081472e6896dfb254c0n,
    0xff2ea16466c96a3843ec78b326b52861n,
    0xfe5dee046a99a2a811c461f1969c3053n,
    0xfcbe86c7900a88aedcffc83b479aa3a4n,
    0xf987a7253ac413176f2b074cf7815e54n,
    0xf3392b0822b70005940c7a398e4b70f3n,
    0xe7159475a2c29b7443b29c7fa6e889d9n,
    0xd097f3bdfd2022b8845ad8f792aa5825n,
    0xa9f746462d870fdf8a65dc1f90e061e5n,
    0x70d869a156d2a1b890bb3df62baf32f7n,
    0x31be135f97d08fd981231505542fcfa6n,
    0x09aa508b5b7a84e1c677de54f3e99bc9n,
    0x005d6af8dedb81196699c329225ee604n,
    0x00002216e584f5fa1ea926041bedfe98n,
    0x000000048a170391f7dc42444e8fa2n,
] as const;

const sqrtPriceSchema = z.bigint().positive();

const liquiditySchema = z.bigint().nonnegative();

const dividingLiquiditySchema = z.bigint().positive();

const tickSchema = z.int().min(MIN_TICK).max(MAX_TICK);

const sqrtRatioSchema = z.bigint().gte(MIN_SQRT_RATIO).lt(MAX_SQRT_RATIO);

const tickListSchema = z.array(z.object({ index: tickSchema, liquidityNet: z.bigint() }));

const poolScalarsSchema = z.object({
    sqrtPriceX96: sqrtRatioSchema,
    liquidity: z.bigint().nonnegative(),
    tick: tickSchema,
    tickSpacing: z.int().positive(),
    feePips: z.bigint().nonnegative().lt(FEE_PIPS_DENOMINATOR),
});

type TickList = z.infer<typeof tickListSchema>;

export const concentratedLiquiditySchema = {
    amountDelta: z.object({
        sqrtRatioAX96: sqrtPriceSchema,
        sqrtRatioBX96: sqrtPriceSchema,
        liquidity: liquiditySchema,
        roundUp: z.boolean(),
    }),
    nextSqrtPrice: z.object({
        sqrtPriceX96: sqrtPriceSchema,
        liquidity: dividingLiquiditySchema,
        amount: z.bigint().nonnegative(),
        zeroForOne: z.boolean(),
    }),
    computeSwapStep: z.object({
        sqrtRatioCurrentX96: sqrtPriceSchema,
        sqrtRatioTargetX96: sqrtPriceSchema,
        liquidity: liquiditySchema,
        amountRemaining: z.bigint().positive(),
        feePips: z.bigint().nonnegative().lt(FEE_PIPS_DENOMINATOR),
    }),
    // the whole-pool check, including every tick. it belongs where pools are read, not in a swap:
    // on a 1454-tick pool it measured 97.9us against 1.0us for the scalars, 43% of the swap.
    pool: poolScalarsSchema
        .extend({ ticks: tickListSchema })
        .refine(
            ({ tickSpacing, ticks }) => ticks.every(({ index }) => index % tickSpacing === 0),
            "every initialised tick must be a multiple of tickSpacing",
        )
        .refine(
            ({ ticks }) => ticks.every((entry, position) => position === 0 || ticks[position - 1]!.index < entry.index),
            "ticks must be sorted ascending, which is what lets a swap walk them with a cursor",
        ),
} as const;

const swapSchema = z.object({
    // ticks were validated when the pool was read and are immutable afterwards, so the array is
    // checked for its shape rather than element by element.
    pool: poolScalarsSchema.extend({ ticks: z.custom<TickList>(Array.isArray, "ticks must be an array") }),
    amountSpecified: z.bigint().positive(),
    zeroForOne: z.boolean(),
    sqrtPriceLimitX96: z.bigint().positive(),
});

type AmountDeltaParams = z.infer<typeof concentratedLiquiditySchema.amountDelta>;

type NextSqrtPriceParams = z.infer<typeof concentratedLiquiditySchema.nextSqrtPrice>;

type ComputeSwapStepParams = z.infer<typeof concentratedLiquiditySchema.computeSwapStep>;

type SwapParams = z.infer<typeof swapSchema>;

type ConcentratedPool = SwapParams["pool"];

function sorted(sqrtRatioAX96: bigint, sqrtRatioBX96: bigint): [bigint, bigint] {
    return sqrtRatioAX96 > sqrtRatioBX96 ? [sqrtRatioBX96, sqrtRatioAX96] : [sqrtRatioAX96, sqrtRatioBX96];
}

// v3 walks a bitmap word at a time, which can stop on an uninitialised tick. that only changes how
// many iterations the loop takes, never the result, so walking the sorted list gives identical output.
//
// position is found once by binary search and then stepped, because a swap only ever moves in one
// direction. the previous version rescanned every tick on every iteration and allocated two arrays
// to do it, which made a swap O(ticks x steps): 3.0ms on a 20M USDC trade across 1454 ticks.
function tickCursorAt(ticks: TickList, tick: number, zeroForOne: boolean): number {
    let low = 0;
    let high = ticks.length;

    while (low < high) {
        const middle = (low + high) >>> 1;

        if (ticks[middle]!.index <= tick) {
            low = middle + 1;
        } else {
            high = middle;
        }
    }

    // low is now the first tick above the current one. going down wants the last one at or below it.
    return zeroForOne ? low - 1 : low;
}

function getSqrtRatioAtTick(tick: z.infer<typeof tickSchema>): bigint {
    tickSchema.parse(tick);

    const absoluteTick = BigInt(Math.abs(tick));
    let ratio = Q128;

    for (const [index, constant] of TICK_RATIOS.entries()) {
        if ((absoluteTick >> BigInt(index)) & 1n) {
            ratio = (ratio * constant) >> 128n;
        }
    }

    if (tick > 0) {
        ratio = UINT256_MAX / ratio;
    }

    // Q128.128 down to Q128.96, rounding up so the ratio never understates the price
    return (ratio >> 32n) + (ratio % 2n ** 32n === 0n ? 0n : 1n);
}

function getTickAtSqrtRatio(sqrtPriceX96: z.infer<typeof sqrtRatioSchema>): number {
    sqrtRatioSchema.parse(sqrtPriceX96);

    let low = MIN_TICK;
    let high = MAX_TICK;

    while (low < high) {
        const middle = Math.ceil((low + high) / 2);

        if (getSqrtRatioAtTick(middle) <= sqrtPriceX96) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }

    return low;
}

function getAmount0Delta(params: AmountDeltaParams): bigint {
    const { sqrtRatioAX96, sqrtRatioBX96, liquidity, roundUp } = concentratedLiquiditySchema.amountDelta.parse(params);

    const [lower, upper] = sorted(sqrtRatioAX96, sqrtRatioBX96);
    const numerator = liquidity * Q96;
    const priceGap = upper - lower;

    return roundUp
        ? mulDivRoundingUp({
              value: mulDivRoundingUp({ value: numerator, multiplier: priceGap, denominator: upper }),
              multiplier: 1n,
              denominator: lower,
          })
        : mulDiv({ value: numerator, multiplier: priceGap, denominator: upper }) / lower;
}

function getAmount1Delta(params: AmountDeltaParams): bigint {
    const { sqrtRatioAX96, sqrtRatioBX96, liquidity, roundUp } = concentratedLiquiditySchema.amountDelta.parse(params);

    const [lower, upper] = sorted(sqrtRatioAX96, sqrtRatioBX96);
    const scaled = { value: liquidity, multiplier: upper - lower, denominator: Q96 };

    return roundUp ? mulDivRoundingUp(scaled) : mulDiv(scaled);
}

// spending token0 lowers the price, spending token1 raises it. bigint cannot overflow, so the
// uint256 overflow branches in the solidity collapse to one path here.
function getNextSqrtPriceFromInput(params: NextSqrtPriceParams): bigint {
    const { sqrtPriceX96, liquidity, amount, zeroForOne } = concentratedLiquiditySchema.nextSqrtPrice.parse(params);

    if (!zeroForOne) {
        return sqrtPriceX96 + mulDiv({ value: amount, multiplier: Q96, denominator: liquidity });
    }

    if (amount === 0n) {
        return sqrtPriceX96;
    }

    const numerator = liquidity * Q96;

    return mulDivRoundingUp({ value: numerator, multiplier: sqrtPriceX96, denominator: numerator + amount * sqrtPriceX96 });
}

function computeSwapStep(params: ComputeSwapStepParams): SwapStep {
    const { sqrtRatioCurrentX96, sqrtRatioTargetX96, liquidity, amountRemaining, feePips } =
        concentratedLiquiditySchema.computeSwapStep.parse(params);

    const zeroForOne = sqrtRatioCurrentX96 >= sqrtRatioTargetX96;
    const amountRemainingLessFee = mulDiv({
        value: amountRemaining,
        multiplier: FEE_PIPS_DENOMINATOR - feePips,
        denominator: FEE_PIPS_DENOMINATOR,
    });

    const amountInToTarget = zeroForOne
        ? getAmount0Delta({ sqrtRatioAX96: sqrtRatioTargetX96, sqrtRatioBX96: sqrtRatioCurrentX96, liquidity, roundUp: true })
        : getAmount1Delta({ sqrtRatioAX96: sqrtRatioCurrentX96, sqrtRatioBX96: sqrtRatioTargetX96, liquidity, roundUp: true });

    const sqrtRatioNextX96 =
        amountRemainingLessFee >= amountInToTarget
            ? sqrtRatioTargetX96
            : getNextSqrtPriceFromInput({ sqrtPriceX96: sqrtRatioCurrentX96, liquidity, amount: amountRemainingLessFee, zeroForOne });

    const reachedTarget = sqrtRatioNextX96 === sqrtRatioTargetX96;

    const amountIn = reachedTarget
        ? amountInToTarget
        : zeroForOne
          ? getAmount0Delta({ sqrtRatioAX96: sqrtRatioNextX96, sqrtRatioBX96: sqrtRatioCurrentX96, liquidity, roundUp: true })
          : getAmount1Delta({ sqrtRatioAX96: sqrtRatioCurrentX96, sqrtRatioBX96: sqrtRatioNextX96, liquidity, roundUp: true });

    const amountOut = zeroForOne
        ? getAmount1Delta({ sqrtRatioAX96: sqrtRatioNextX96, sqrtRatioBX96: sqrtRatioCurrentX96, liquidity, roundUp: false })
        : getAmount0Delta({ sqrtRatioAX96: sqrtRatioCurrentX96, sqrtRatioBX96: sqrtRatioNextX96, liquidity, roundUp: false });

    // stopping short of the target means the trader spent everything they had left, so the fee is
    // whatever remains rather than a rate applied to the amount actually swapped.
    const feeAmount = reachedTarget
        ? mulDivRoundingUp({ value: amountIn, multiplier: feePips, denominator: FEE_PIPS_DENOMINATOR - feePips })
        : amountRemaining - amountIn;

    return { sqrtRatioNextX96, amountIn, amountOut, feeAmount };
}

export function swap(params: SwapParams): SwapResult {
    const { pool, amountSpecified, zeroForOne, sqrtPriceLimitX96 } = swapSchema.parse(params);

    let amountRemaining = amountSpecified;
    let amountCalculated = 0n;
    let sqrtPriceX96 = pool.sqrtPriceX96;
    let tick = pool.tick;
    let liquidity = pool.liquidity;
    let feeAmount = 0n;
    let ticksCrossed = 0;
    let exhaustedTicks = false;

    let cursor = tickCursorAt(pool.ticks, tick, zeroForOne);

    while (amountRemaining !== 0n && sqrtPriceX96 !== sqrtPriceLimitX96) {
        const nextTick = pool.ticks[cursor];
        const tickNext = nextTick?.index ?? (zeroForOne ? MIN_TICK : MAX_TICK);

        // reaching MIN_TICK or MAX_TICK means the tick list held nothing further in this direction.
        // with liquidity still active and input still to spend, the swap is about to run on stale
        // liquidity that the unloaded ticks would have removed, which overstates the output.
        if ((tickNext === MIN_TICK || tickNext === MAX_TICK) && liquidity > 0n) {
            exhaustedTicks = true;
        }

        const sqrtPriceNextX96 = getSqrtRatioAtTick(tickNext);
        const beyondLimit = zeroForOne ? sqrtPriceNextX96 < sqrtPriceLimitX96 : sqrtPriceNextX96 > sqrtPriceLimitX96;

        const step = computeSwapStep({
            sqrtRatioCurrentX96: sqrtPriceX96,
            sqrtRatioTargetX96: beyondLimit ? sqrtPriceLimitX96 : sqrtPriceNextX96,
            liquidity,
            amountRemaining,
            feePips: pool.feePips,
        });

        feeAmount += step.feeAmount;

        amountRemaining -= step.amountIn + step.feeAmount;
        amountCalculated += step.amountOut;

        if (step.sqrtRatioNextX96 === sqrtPriceNextX96) {
            if (nextTick !== undefined) {
                liquidity += zeroForOne ? -nextTick.liquidityNet : nextTick.liquidityNet;
                ticksCrossed++;
                cursor += zeroForOne ? -1 : 1;
            }

            tick = zeroForOne ? tickNext - 1 : tickNext;
        } else if (step.sqrtRatioNextX96 !== sqrtPriceX96) {
            // the swap stopped inside a range, so the cursor has to be found again rather than stepped
            tick = getTickAtSqrtRatio(step.sqrtRatioNextX96);
            cursor = tickCursorAt(pool.ticks, tick, zeroForOne);
        }

        sqrtPriceX96 = step.sqrtRatioNextX96;
    }

    return {
        exhaustedTicks,
        amountIn: amountSpecified - amountRemaining,
        amountOut: amountCalculated,
        feeAmount,
        sqrtPriceX96After: sqrtPriceX96,
        tickAfter: tick,
        liquidityAfter: liquidity,
        ticksCrossed,
    };
}

export function createClmmSource({ id, chainIds, readPools }: ClmmSourceParams): SwapSource {
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

                const zeroForOne = tokenInIsToken0(pool, tokenIn, tokenOut);

                if (zeroForOne === null) {
                    continue;
                }

                const result = swap({
                    pool: pool.state,
                    amountSpecified: amountIn,
                    zeroForOne,
                    sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_RATIO + 1n : MAX_SQRT_RATIO - 1n,
                });

                // a pool with no liquidity in range pays nothing, and a swap that outran the tick
                // data we loaded would overstate the output. neither is a quote.
                if (result.amountOut === 0n || result.exhaustedTicks) {
                    continue;
                }

                if (best === null || result.amountOut > best.amountOut) {
                    best = { poolId: pool.id, amountOut: result.amountOut, feeAmount: result.feeAmount };
                }
            }

            return best;
        },
    };
}
