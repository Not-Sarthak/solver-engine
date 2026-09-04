import { z } from "zod";

const portSchema = z.string().min(1).transform(Number).pipe(z.number().int().min(1).max(65535));

const positiveIntSchema = z.string().min(1).transform(Number).pipe(z.number().int().positive());

const bpsSchema = z.string().min(1).regex(/^\d+$/).transform(BigInt);

// a solver serves several chains at once, and cross-chain quoting needs at least two of them
const chainIdsSchema = z
    .string()
    .regex(/^\d+(,\d+)*$/, "must be a comma separated list of chain ids")
    .transform((value) => value.split(",").map(Number));

const envSchema = z.object({
    PORT: portSchema,
    SOLVER_CHAIN_IDS: chainIdsSchema,

    FORK_PORT: portSchema,

    QUOTE_TTL_MS: positiveIntSchema,
    RISK_BPS: bpsSchema,
    SERVICE_BPS: bpsSchema,
    APP_BPS: z.string().min(1).regex(/^\d+$/).transform(BigInt),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
    throw new Error(`Invalid environment. Copy .env.example to .env.\n${z.prettifyError(parsed.error)}`);
}

export const {
    PORT,
    SOLVER_CHAIN_IDS,
    FORK_PORT,
    QUOTE_TTL_MS,
    RISK_BPS,
    SERVICE_BPS,
    APP_BPS,
} = parsed.data;

// public endpoints rate limit, and they sometimes stop serving the archive reads a fork needs at
// all: publicnode began answering those with 403 "archive requests require a personal token"
// mid-development, which stopped every fork. any chain's endpoint can therefore be replaced without
// editing the registry, by setting RPC_URL_<chainId> (RPC_URL_1, RPC_URL_8453, and so on).
export function rpcUrlOverride(chainId: number): string | null {
    const url = process.env[`RPC_URL_${chainId}`];

    return url === undefined || url.length === 0 ? null : url;
}
