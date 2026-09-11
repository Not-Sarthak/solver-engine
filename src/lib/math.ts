import { z } from "zod";

// basis point = one hundredth of one percent
export const BPS_DENOMINATOR = 10_000n;

// a rate in basis points is a fraction of one, so it can never reach the denominator
export const bpsSchema = z.bigint().nonnegative().lt(BPS_DENOMINATOR);

const bigIntMathSchema = {
    mulDiv: z.object({
        value: z.bigint().nonnegative(),
        multiplier: z.bigint().nonnegative(),
        denominator: z.bigint().positive(),
    }),
    applyBps: z.object({
        value: z.bigint().nonnegative(),
        bps: z.bigint().nonnegative(),
    }),
    convertDecimals: z.object({
        value: z.bigint().nonnegative(),
        fromDecimals: z.int().nonnegative(),
        toDecimals: z.int().nonnegative(),
    }),
} as const;

type MulDivParams = z.infer<typeof bigIntMathSchema.mulDiv>;

type ApplyBpsParams = z.infer<typeof bigIntMathSchema.applyBps>;

type ConvertDecimalsParams = z.infer<typeof bigIntMathSchema.convertDecimals>;

export function mulDiv(params: MulDivParams): bigint {
    const { value, multiplier, denominator } = bigIntMathSchema.mulDiv.parse(params);

    return (value * multiplier) / denominator;
}

export function mulDivRoundingUp({ value, multiplier, denominator }: MulDivParams): bigint {
    const product = value * multiplier;
    const truncatedQuotient = mulDiv({ value, multiplier, denominator });

    return truncatedQuotient * denominator === product ? truncatedQuotient : truncatedQuotient + 1n;
}

export function applyBps(params: ApplyBpsParams): bigint {
    const { value, bps } = bigIntMathSchema.applyBps.parse(params);

    return mulDiv({ value, multiplier: bps, denominator: BPS_DENOMINATOR });
}

// the same asset can carry different decimals on different chains, so a cross-chain amount has to be
// restated before it means anything on the other side. widening is exact; narrowing truncates, which
// rounds against the solver rather than the user.
export function convertDecimals(params: ConvertDecimalsParams): bigint {
    const { value, fromDecimals, toDecimals } = bigIntMathSchema.convertDecimals.parse(params);

    return toDecimals >= fromDecimals ? value * 10n ** BigInt(toDecimals - fromDecimals) : value / 10n ** BigInt(fromDecimals - toDecimals);
}
