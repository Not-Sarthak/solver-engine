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
    // the key that signs every fill. on a fork it is anvil's public test key; on mainnet it is the
    // hot wallet, and it comes from here rather than from source for exactly that reason
    SOLVER_PRIVATE_KEY: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    // fork: anvil per chain, inventory written into storage, measurements from real receipts.
    // live: real rpc, real signer, real balances, measurements from the node's own simulation.
    EXECUTION_MODE: z.enum(["fork", "live"]),

    FORK_PORT: portSchema,

    DFLOW_API_KEY: z.string().min(1),
    DFLOW_QUOTE_ENDPOINT: z.url(),
    JUPITER_API_KEY: z.string().min(1),
    JUPITER_ULTRASWAP_ENDPOINT: z.url(),

    REDIS_URL: z.url(),
    // how long the writer lease lasts without renewal. one instance holds it and does every write
    // and every send; another waits and takes over within this long of the holder going quiet.
    LEADER_LEASE_MS: positiveIntSchema,

    // the key that opens the routes that show everything: every order, the whole ledger
    ADMIN_API_KEY: z.string().min(16),
    // how many quotes and prices one client may ask for per minute. each one is a real route
    // search and, the first time, a real gas measurement, so an open endpoint is an open bill.
    QUOTE_RATE_LIMIT_PER_MINUTE: positiveIntSchema,

    // the sweeper gives back transfers to the solver that match no order. off means they stay
    // where they landed until an operator looks; the senders listed are the operator's own
    // funding wallets, whose transfers are inventory rather than deposits.
    SWEEP_STRAYS: z.enum(["true", "false"]).transform((value) => value === "true"),
    SWEEP_IGNORE_FROM: z
        .string()
        .transform((value) => (value === "" ? [] : value.split(",")))
        .pipe(z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/))),
    // refund attempts per stray before it is left for an operator
    SWEEP_MAX_ATTEMPTS: positiveIntSchema,

    QUOTE_TTL_MS: positiveIntSchema,
    // how long after accepting a quote the user has to deposit. shorter than the intent deadline
    // on purpose: an accepted quote is a price held open, and holding it open longer is an option
    // the user gets for free.
    DEPOSIT_WINDOW_MS: positiveIntSchema,
    // RISK_BPS is the buffer for a wait of this long. a longer wait scales it up, a shorter one
    // scales it down, with the square root of the ratio, which is how price variance grows with time.
    RISK_HORIZON_MS: positiveIntSchema,
    RISK_BPS: bpsSchema,
    // how long a route's measured gas is trusted before it is measured again
    GAS_CACHE_TTL_MS: positiveIntSchema,
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
    SOLVER_PRIVATE_KEY,
    EXECUTION_MODE,
    FORK_PORT,
    DFLOW_API_KEY,
    DFLOW_QUOTE_ENDPOINT,
    JUPITER_API_KEY,
    JUPITER_ULTRASWAP_ENDPOINT,
    REDIS_URL,
    LEADER_LEASE_MS,
    ADMIN_API_KEY,
    QUOTE_RATE_LIMIT_PER_MINUTE,
    SWEEP_STRAYS,
    SWEEP_IGNORE_FROM,
    SWEEP_MAX_ATTEMPTS,
    QUOTE_TTL_MS,
    DEPOSIT_WINDOW_MS,
    RISK_HORIZON_MS,
    RISK_BPS,
    GAS_CACHE_TTL_MS,
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
