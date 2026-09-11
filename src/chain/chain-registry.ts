import { z } from "zod";
import { getAddress, type Address } from "viem";
import { rpcUrlOverride } from "../lib/config";

// every entry below was checked against the chain, not taken from memory: each init code hash was
// used to derive a pool address by CREATE2 and compared with what the factory itself reports, and
// each router was made to execute a real swap on a fork. pancakeswap is absent because its hash did
// not reproduce, and sushiswap v3 because its router was never verified. an unverified address here
// is a wrong price, not an error.
const UNISWAP_V3_HASH = "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54";

const UNISWAP_V2_HASH = "0x96e8ac4277198ff8b6f785478aa9a39f403cb768dd02cbee326c3e7da348845f";

const SUSHISWAP_V2_HASH = "0xe18a34eb0e04b04f7a0ac29a6e80748dca96319b42c54d679cb821dca90c6303";

// pancakeswap publishes this in its sdk, and it only reproduces a pool when derived from the pool
// deployer rather than the factory, which is a separate contract there
const PANCAKESWAP_V3_HASH = "0x6ce8eb472fa82df5469c6ab6d485f17c3ad13c8cd7af59b3d4a8026c5ce0f7e2";

// hyperswap publishes no source. this was read out of its router's bytecode, where the PoolAddress
// library keeps it as a PUSH32 constant, and confirmed by deriving the live WHYPE/USD~0 pool
const HYPERSWAP_V3_HASH = "0xe3572921be1688dba92df30c6781b8770499ff274d20ae9b325f4242634774fb";

const UNISWAP_V3_TIERS = [100, 500, 3000, 10000] as const;

const PANCAKESWAP_V3_TIERS = [100, 500, 2500, 10000] as const;

const AMM_FEE_BPS = 30n;

const PANCAKESWAP_FACTORY = "0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865";

const PANCAKESWAP_DEPLOYER = "0x41ff9aa7e16b8b1a8a8dc4f0efacd93d02d071c9";

const lowerAddress = z.string().regex(/^0x[0-9a-f]{40}$/);

// an amm is data. adding one is an entry here, never a new code path, which is the same shape relay
// uses to carry 33 swap sources without 33 integrations.
const ammSchema = z.discriminatedUnion("kind", [
    z.object({
        kind: z.literal("v2"),
        id: z.string().min(1),
        factory: lowerAddress,
        initCodeHash: z.string().regex(/^0x[0-9a-f]{64}$/),
        router: lowerAddress,
        // uniswap's SwapRouter02 dropped the deadline argument. every fork still runs the original
        // router that takes it, and calling one with the other's signature reverts: verified on a
        // fork, where sushiswap's router accepted the deadline form and rejected the other.
        routerTakesDeadline: z.boolean(),
        feeBps: z.bigint().positive(),
    }),
    z.object({
        kind: z.literal("v3"),
        id: z.string().min(1),
        factory: lowerAddress,
        // the contract that actually runs CREATE2. usually the factory itself, but pancakeswap
        // splits deployment into its own contract, and deriving from the factory names nothing.
        deployer: lowerAddress,
        initCodeHash: z.string().regex(/^0x[0-9a-f]{64}$/),
        router: lowerAddress,
        // the original v3 SwapRouter carries a deadline inside ExactInputSingleParams; SwapRouter02
        // dropped it. sushiswap and hyperswap run the original, uniswap and pancakeswap the other.
        // each was made to execute a swap on a fork with both encodings and accepted exactly one.
        routerTakesDeadline: z.boolean(),
        feeTiers: z.array(z.int().positive()).min(1),
    }),
]);

const base58Address = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "must be a base58 address");

// asset is what makes a token the same thing on two chains. addresses differ per chain, so a
// cross-chain quote needs a label to join on, and it has to be curated data rather than a guess:
// polygon's wrapped native is WMATIC while it also carries a bridged WETH, and matching those by
// "the wrapped native token" would silently price WPOL as ETH.
//
// symbol is the on-chain fact each address was verified against, and it is not always the label:
// tether's arbitrum token reports USD~0 but is still tether usd, so it joins as USDT.
const hubToken = (address: z.ZodType<string>) => z.object({ asset: z.string().min(1), symbol: z.string().min(1), address });

// addresses are stored lowercase and checksummed on the way out; a mis-cased literal is a real
// bug class that viem rejects at call time rather than at startup.
//
// vmType is a field, not a class hierarchy: every chain has one shape and the differences are in
// which fields carry what. an svm chain has no amms because its liquidity is reached through
// routers that do the routing themselves, and it cannot be filled on here because there is no
// signer and no fork for it, so it can only ever be the origin of a cross-chain intent.
const chainSchema = z.discriminatedUnion("vmType", [
    z.object({
        id: z.int().positive(),
        name: z.string().min(1),
        vmType: z.literal("evm"),
        rpcUrl: z.url(),
        // the chain's block interval, a protocol constant. it is how often loaded pool state can
        // change, so it is how often the solver asks the chain whether it has.
        blockTimeMs: z.int().positive(),
        wrappedNative: lowerAddress,
        hubTokens: z.array(hubToken(lowerAddress)).min(1),
        amms: z.array(ammSchema).min(1),
    }),
    z.object({
        id: z.int().positive(),
        name: z.string().min(1),
        vmType: z.literal("svm"),
        rpcUrl: z.url(),
        wrappedNative: base58Address,
        hubTokens: z.array(hubToken(base58Address)).min(1),
        amms: z.array(ammSchema).max(0),
    }),
]);

export type ChainConfig = z.infer<typeof chainSchema>;

// forking needs state at a specific block, which most free endpoints class as an archive request.
// publicnode served these until it began answering them with 403 "archive requests require a
// personal token", which stopped every fork.
//
// the endpoints are also spread across providers on purpose. a rate limit is per provider, so
// pointing two chains at the same one makes a cross-chain quote compete with itself: forking base
// through the same host as ethereum failed at 90s while forking it alone took under 30. these are
// still public endpoints and will throttle under load, which is what RPC_URL_<chainId> is for.
const CHAINS = [
    {
        id: 1,
        blockTimeMs: 12_000,
        name: "ethereum",
        vmType: "evm",
        rpcUrl: "https://eth-mainnet.public.blastapi.io",
        wrappedNative: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
        hubTokens: [
            { asset: "WETH", symbol: "WETH", address: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2" },
            { asset: "USDC", symbol: "USDC", address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48" },
            { asset: "USDT", symbol: "USDT", address: "0xdac17f958d2ee523a2206206994597c13d831ec7" },
            { asset: "DAI", symbol: "DAI", address: "0x6b175474e89094c44da98b954eedeac495271d0f" },
            { asset: "WBTC", symbol: "WBTC", address: "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599" },
        ],
        amms: [
            {
                kind: "v3",
                id: "uniswap-v3",
                factory: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
                deployer: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
                initCodeHash: UNISWAP_V3_HASH,
                router: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
                routerTakesDeadline: false,
                feeTiers: [...UNISWAP_V3_TIERS],
            },
            {
                kind: "v2",
                id: "uniswap-v2",
                factory: "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f",
                initCodeHash: UNISWAP_V2_HASH,
                router: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
                routerTakesDeadline: false,
                feeBps: AMM_FEE_BPS,
            },
            {
                kind: "v3",
                id: "sushiswap-v3",
                factory: "0xbaceb8ec6b9355dfc0269c18bac9d6e2bdc29c4f",
                deployer: "0xbaceb8ec6b9355dfc0269c18bac9d6e2bdc29c4f",
                initCodeHash: UNISWAP_V3_HASH,
                router: "0x2e6cd2d30aa43f40aa81619ff4b6e0a41479b13f",
                routerTakesDeadline: true,
                feeTiers: [...UNISWAP_V3_TIERS],
            },
            {
                kind: "v3",
                id: "pancakeswap-v3",
                factory: PANCAKESWAP_FACTORY,
                deployer: PANCAKESWAP_DEPLOYER,
                initCodeHash: PANCAKESWAP_V3_HASH,
                router: "0x13f4ea83d0bd40e75c8222255bc855a974568dd4",
                routerTakesDeadline: false,
                feeTiers: [...PANCAKESWAP_V3_TIERS],
            },
            {
                kind: "v2",
                id: "sushiswap-v2",
                factory: "0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac",
                initCodeHash: SUSHISWAP_V2_HASH,
                router: "0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f",
                routerTakesDeadline: true,
                feeBps: AMM_FEE_BPS,
            },
        ],
    },
    {
        id: 8453,
        blockTimeMs: 2_000,
        name: "base",
        vmType: "evm",
        rpcUrl: "https://base-mainnet.public.blastapi.io",
        wrappedNative: "0x4200000000000000000000000000000000000006",
        hubTokens: [
            { asset: "WETH", symbol: "WETH", address: "0x4200000000000000000000000000000000000006" },
            { asset: "USDC", symbol: "USDC", address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913" },
        ],
        amms: [
            {
                kind: "v3",
                id: "uniswap-v3",
                factory: "0x33128a8fc17869897dce68ed026d694621f6fdfd",
                deployer: "0x33128a8fc17869897dce68ed026d694621f6fdfd",
                initCodeHash: UNISWAP_V3_HASH,
                router: "0x2626664c2603336e57b271c5c0b26f421741e481",
                routerTakesDeadline: false,
                feeTiers: [...UNISWAP_V3_TIERS],
            },
            {
                kind: "v2",
                id: "uniswap-v2",
                factory: "0x8909dc15e40173ff4699343b6eb8132c65e18ec6",
                initCodeHash: UNISWAP_V2_HASH,
                router: "0x2626664c2603336e57b271c5c0b26f421741e481",
                routerTakesDeadline: false,
                feeBps: AMM_FEE_BPS,
            },
            {
                kind: "v3",
                id: "sushiswap-v3",
                factory: "0xc35dadb65012ec5796536bd9864ed8773abc74c4",
                deployer: "0xc35dadb65012ec5796536bd9864ed8773abc74c4",
                initCodeHash: UNISWAP_V3_HASH,
                router: "0xfb7ef66a7e61224dd6fcd0d7d9c3be5c8b049b9f",
                routerTakesDeadline: true,
                feeTiers: [...UNISWAP_V3_TIERS],
            },
            {
                kind: "v3",
                id: "pancakeswap-v3",
                factory: PANCAKESWAP_FACTORY,
                deployer: PANCAKESWAP_DEPLOYER,
                initCodeHash: PANCAKESWAP_V3_HASH,
                router: "0x678aa4bf4e210cf2166753e054d5b7c31cc7fa86",
                routerTakesDeadline: false,
                feeTiers: [...PANCAKESWAP_V3_TIERS],
            },
        ],
    },
    {
        id: 42161,
        blockTimeMs: 250,
        name: "arbitrum",
        vmType: "evm",
        rpcUrl: "https://arbitrum-one.public.blastapi.io",
        wrappedNative: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1",
        hubTokens: [
            { asset: "WETH", symbol: "WETH", address: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1" },
            { asset: "USDC", symbol: "USDC", address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" },
            { asset: "USDT", symbol: "USD₮0", address: "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9" },
        ],
        amms: [
            {
                kind: "v3",
                id: "uniswap-v3",
                factory: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
                deployer: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
                initCodeHash: UNISWAP_V3_HASH,
                router: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
                routerTakesDeadline: false,
                feeTiers: [...UNISWAP_V3_TIERS],
            },
            {
                kind: "v2",
                id: "uniswap-v2",
                factory: "0xf1d7cc64fb4452f05c498126312ebe29f30fbcf9",
                initCodeHash: UNISWAP_V2_HASH,
                router: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
                routerTakesDeadline: false,
                feeBps: AMM_FEE_BPS,
            },
            {
                kind: "v3",
                id: "sushiswap-v3",
                factory: "0x1af415a1eba07a4986a52b6f2e7de7003d82231e",
                deployer: "0x1af415a1eba07a4986a52b6f2e7de7003d82231e",
                initCodeHash: UNISWAP_V3_HASH,
                router: "0x8a21f6768c1f8075791d08546dadf6daa0be820c",
                routerTakesDeadline: true,
                feeTiers: [...UNISWAP_V3_TIERS],
            },
            {
                kind: "v3",
                id: "pancakeswap-v3",
                factory: PANCAKESWAP_FACTORY,
                deployer: PANCAKESWAP_DEPLOYER,
                initCodeHash: PANCAKESWAP_V3_HASH,
                router: "0x32226588378236fd0c7c4053999f88ac0e5cac77",
                routerTakesDeadline: false,
                feeTiers: [...PANCAKESWAP_V3_TIERS],
            },
            {
                kind: "v2",
                id: "sushiswap-v2",
                factory: "0xc35dadb65012ec5796536bd9864ed8773abc74c4",
                initCodeHash: SUSHISWAP_V2_HASH,
                router: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
                routerTakesDeadline: true,
                feeBps: AMM_FEE_BPS,
            },
        ],
    },
    {
        id: 10,
        blockTimeMs: 2_000,
        name: "optimism",
        vmType: "evm",
        rpcUrl: "https://mainnet.optimism.io",
        wrappedNative: "0x4200000000000000000000000000000000000006",
        hubTokens: [
            { asset: "WETH", symbol: "WETH", address: "0x4200000000000000000000000000000000000006" },
            { asset: "USDC", symbol: "USDC", address: "0x0b2c639c533813f4aa9d7837caf62653d097ff85" },
        ],
        amms: [
            {
                kind: "v3",
                id: "uniswap-v3",
                factory: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
                deployer: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
                initCodeHash: UNISWAP_V3_HASH,
                router: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
                routerTakesDeadline: false,
                feeTiers: [...UNISWAP_V3_TIERS],
            },
            {
                kind: "v2",
                id: "uniswap-v2",
                factory: "0x0c3c1c532f1e39edf36be9fe0be1410313e074bf",
                initCodeHash: UNISWAP_V2_HASH,
                router: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
                routerTakesDeadline: false,
                feeBps: AMM_FEE_BPS,
            },
            {
                kind: "v3",
                id: "sushiswap-v3",
                factory: "0x9c6522117e2ed1fe5bdb72bb0ed5e3f2bde7dbe0",
                deployer: "0x9c6522117e2ed1fe5bdb72bb0ed5e3f2bde7dbe0",
                initCodeHash: UNISWAP_V3_HASH,
                router: "0x8c32fd078b89eccb06b40289a539d84a4aa9fda6",
                routerTakesDeadline: true,
                feeTiers: [...UNISWAP_V3_TIERS],
            },
        ],
    },
    {
        id: 137,
        blockTimeMs: 2_000,
        name: "polygon",
        vmType: "evm",
        rpcUrl: "https://polygon.drpc.org",
        wrappedNative: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270",
        hubTokens: [
            { asset: "WPOL", symbol: "WPOL", address: "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270" },
            { asset: "USDC", symbol: "USDC", address: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359" },
            { asset: "WETH", symbol: "WETH", address: "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619" },
        ],
        amms: [
            {
                kind: "v3",
                id: "uniswap-v3",
                factory: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
                deployer: "0x1f98431c8ad98523631ae4a59f267346ea31f984",
                initCodeHash: UNISWAP_V3_HASH,
                router: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
                routerTakesDeadline: false,
                feeTiers: [...UNISWAP_V3_TIERS],
            },
            {
                kind: "v2",
                id: "uniswap-v2",
                factory: "0x9e5a52f57b3038f1b8eee45f28b3c1967e22799c",
                initCodeHash: UNISWAP_V2_HASH,
                router: "0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45",
                routerTakesDeadline: false,
                feeBps: AMM_FEE_BPS,
            },
            {
                kind: "v3",
                id: "sushiswap-v3",
                factory: "0x917933899c6a5f8e37f31e19f92cdbff7e8ff0e2",
                deployer: "0x917933899c6a5f8e37f31e19f92cdbff7e8ff0e2",
                initCodeHash: UNISWAP_V3_HASH,
                router: "0x0af89e1620b96170e2a9d0b68feebb767ed044c3",
                routerTakesDeadline: true,
                feeTiers: [...UNISWAP_V3_TIERS],
            },
            {
                kind: "v2",
                id: "sushiswap-v2",
                factory: "0xc35dadb65012ec5796536bd9864ed8773abc74c4",
                initCodeHash: SUSHISWAP_V2_HASH,
                router: "0x1b02da8cb0d097eb8d57a175b88c7d8b47997506",
                routerTakesDeadline: true,
                feeBps: AMM_FEE_BPS,
            },
            {
                kind: "v2",
                id: "quickswap-v2",
                factory: "0x5757371414417b8c6caad45baef941abc7d3ab32",
                initCodeHash: UNISWAP_V2_HASH,
                router: "0xa5e0829caced8ffdd4de3c43696c57f7d7a678ff",
                routerTakesDeadline: true,
                feeBps: AMM_FEE_BPS,
            },
        ],
    },
] as const satisfies readonly ChainConfig[];

// a chain is a data entry, so the data is checked the way a request body would be: every address
// in the shape its chain expects, every amm complete, at load rather than at the first quote
z.array(chainSchema).parse(CHAINS);

export const chainRegistry = {
    all: (): readonly ChainConfig[] => CHAINS,

    get(chainId: number): ChainConfig {
        const chain = CHAINS.find((candidate) => candidate.id === chainId);

        if (chain === undefined) {
            throw new Error(`Unsupported chain ${chainId}. Known: ${CHAINS.map((candidate) => candidate.id).join(", ")}`);
        }

        return chain;
    },

    has: (chainId: number): boolean => CHAINS.some((candidate) => candidate.id === chainId),
};

export function rpcUrlFor(chain: ChainConfig): string {
    return rpcUrlOverride(chain.id) ?? chain.rpcUrl;
}

export function checksum(address: string): Address {
    return getAddress(address);
}
