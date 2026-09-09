import { z } from "zod";
import { FailureReason } from "../orders/failures";
import { logger } from "../lib/logger";
import { applyBps, bpsSchema, isqrt } from "../lib/math";
import { type Path } from "./routing";

type FeeBreakdown = {
    relayerGas: bigint;
    relayerService: bigint;
    app: bigint;
    settlement: bigint;
    rebalance: bigint;
    riskBuffer: bigint;
};

export type PricedQuote = {
    quotedAmountOut: bigint;
    expectedProfit: bigint;
    fees: FeeBreakdown;
    path: Path;
};

export type PricingRejection = {
    reason: FailureReason;
    quotedAmountOut: bigint;
    expectedProfit: bigint;
    fees: FeeBreakdown;
};

const pricingSchema = z.object({
    path: z.custom<Path>((value) => value !== null && typeof value === "object" && "netAmountOut" in value),
    riskBps: bpsSchema,
    serviceBps: bpsSchema,
    appBps: bpsSchema,
    settlementCost: z.bigint().nonnegative(),
    rebalanceCost: z.bigint().nonnegative(),
    minAmountOut: z.bigint().nonnegative(),
});

type PricingParams = z.infer<typeof pricingSchema>;

function describePath(path: Path): string {
    return path.legs.map((leg) => `${leg.quote.sourceId}:${leg.quote.poolId}`).join(" -> ");
}

// the buffer is priced for one wait and charged for another. price variance grows with time, so
// the buffer grows with the square root of it: four times the wait, twice the buffer.
export function scaleRiskBps({ riskBps, waitMs, horizonMs }: { riskBps: bigint; waitMs: bigint; horizonMs: bigint }): bigint {
    return (riskBps * isqrt((waitMs * 1_000_000n) / horizonMs)) / 1_000n;
}

export function priceQuote({
    path,
    riskBps,
    serviceBps,
    appBps,
    settlementCost,
    rebalanceCost,
    minAmountOut,
}: PricingParams): PricedQuote | PricingRejection {
    pricingSchema.parse({ path, riskBps, serviceBps, appBps, settlementCost, rebalanceCost, minAmountOut });

    const grossAmountOut = path.amountOut;
    const fees: FeeBreakdown = {
        relayerGas: path.gasCostInOutputToken,
        relayerService: applyBps({ value: grossAmountOut, bps: serviceBps }),
        app: applyBps({ value: grossAmountOut, bps: appBps }),
        settlement: settlementCost,
        rebalance: rebalanceCost,
        riskBuffer: applyBps({ value: grossAmountOut, bps: riskBps }),
    };

    const quotedAmountOut = grossAmountOut - fees.relayerGas - fees.relayerService - fees.app - fees.settlement - fees.rebalance - fees.riskBuffer;

    // the risk buffer is profit only in expectation: it is kept when the fill lands at the quoted
    // price and consumed when it does not. the app fee is collected on someone else's behalf.
    const expectedProfit = fees.relayerService + fees.riskBuffer;

    const rejection = (reason: FailureReason): PricingRejection => {
        logger.warn("Refused To Quote: ", { reason, route: describePath(path), quotedAmountOut: quotedAmountOut.toString() });

        return { reason, quotedAmountOut, expectedProfit, fees };
    };

    if (quotedAmountOut <= 0n) {
        return rejection(FailureReason.NEGATIVE_AMOUNT_AFTER_FEES);
    }

    if (expectedProfit <= 0n) {
        return rejection(FailureReason.UNPROFITABLE);
    }

    if (quotedAmountOut < minAmountOut) {
        return rejection(FailureReason.BELOW_MINIMUM_OUTPUT);
    }

    return { quotedAmountOut, expectedProfit, fees, path };
}
