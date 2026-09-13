import { type Address, type PublicClient } from "viem";
import { erc20Abi } from "../chain/abis";
import { createPoolRepository } from "../chain/pool-repository";
import { chainRegistry } from "../chain/chain-registry";
import { isSameAddress } from "../lib/address";
import { createClmmSource } from "../sources/concentrated-liquidity";
import { createCpmmSource } from "../sources/constant-product";
import { createDflowSource } from "../sources/dflow";
import { createJupiterSource } from "../sources/jupiter";
import { createSourceRegistry } from "../sources/source-registry";
import { type GasPricing } from "./routing";

export type ChainEnvironment = {
    chain: ReturnType<typeof chainRegistry.get>;
    repository: ReturnType<typeof createPoolRepository> | null;
    sources: ReturnType<typeof createSourceRegistry>;
    hubAssets: ReturnType<typeof chainRegistry.get>["hubTokens"];
    hubTokens: readonly string[];
    readHubDecimals(): Promise<ReadonlyMap<string, number>>;
    pinnedGasPrice(): Promise<bigint>;
    // gas is paid in the native token and compared in the output token. the rate comes from real
    // liquidity rather than a hardcoded price: a pool on evm, a router quote on solana.
    readGasPricing(outputToken: string, gasPriceWei: bigint): Promise<GasPricing>;
    // bring loaded pool state and the gas price forward to `toBlock`, replaying pool events read
    // from `source`: the chain the fills land on, which is the fork in fork mode
    sync(source: PublicClient, toBlock: bigint): Promise<{ reshaped: Address[] }>;
    // origin-side costs for a chain with no fork to measure them on. null means measure on the fork.
    // on solana the unit is signatures and the price is the protocol's per-signature fee, so the
    // numbers are facts about the chain rather than estimates of it.
    originCosts: { settlement(): Promise<bigint>; rebalance(): Promise<bigint> } | null;
};

const Q192 = 2n ** 192n;

// solana charges a base fee per signature rather than per unit of work, and the number is a protocol
// constant, not an estimate. priority fees on top are optional and chosen by the sender; they are
// not modelled, which is stated rather than hidden.
const LAMPORTS_PER_SIGNATURE = 5_000n;

const LAMPORTS_PER_SOL = 10n ** 9n;

// claiming a deposit is one transfer and converting it is one swap, each signed once. jupiter ultra
// reports itself gasless and would make the swap free, but the floor is charged regardless so the
// quote does not depend on which router happens to win.
const SIGNATURES_PER_TRANSACTION = 1n;

function evmEnvironment(
    chain: Extract<ReturnType<typeof chainRegistry.get>, { vmType: "evm" }>,
    client: PublicClient,
    blockNumber: bigint,
    now: () => number,
): ChainEnvironment {
    const repository = createPoolRepository({ client, chainId: chain.id, blockNumber, now });

    const sources = createSourceRegistry([
        createCpmmSource({
            id: "constant-product",
            chainIds: [chain.id],
            readPools: () =>
                repository.allConstantProduct().map((pool) => ({
                    id: pool.address,
                    chainId: chain.id,
                    token0: pool.token0,
                    token1: pool.token1,
                    reserve0: pool.reserve0,
                    reserve1: pool.reserve1,
                    feeBps: pool.feeBps,
                })),
        }),
        createClmmSource({
            id: "concentrated-liquidity",
            chainIds: [chain.id],
            readPools: () =>
                repository.allConcentrated().map((pool) => ({
                    id: pool.address,
                    chainId: chain.id,
                    token0: pool.token0,
                    token1: pool.token1,
                    state: {
                        sqrtPriceX96: pool.sqrtPriceX96,
                        liquidity: pool.liquidity,
                        tick: pool.tick,
                        tickSpacing: pool.tickSpacing,
                        feePips: pool.feePips,
                        ticks: pool.ticks,
                    },
                })),
        }),
    ]);

    let hubDecimals: Promise<ReadonlyMap<string, number>> | null = null;
    let gasPrice: Promise<bigint> | null = null;

    return {
        chain,
        repository,
        sources,
        hubAssets: chain.hubTokens,
        hubTokens: chain.hubTokens.map(({ address }) => address),

        // decimals are read from the tokens rather than declared, because a cross-chain amount is
        // restated between them and a wrong constant there is a silently wrong quote.
        readHubDecimals() {
            hubDecimals ??= client
                .multicall({
                    contracts: chain.hubTokens.map(({ address }) => ({
                        address: address as Address,
                        abi: erc20Abi,
                        functionName: "decimals" as const,
                    })),
                    allowFailure: false,
                })
                .then((results) => new Map(chain.hubTokens.map(({ address }, index) => [address, Number(results[index])])));

            return hubDecimals;
        },

        // read once, at the block the pool state is pinned to. a quote priced from block-N reserves
        // has to use block-N gas or it is quoting two different moments at once. it was also the
        // whole warm quote: the round trip measured p50 177ms against a 173ms quote. caching the
        // promise rather than the value dedupes concurrent quotes.
        pinnedGasPrice() {
            gasPrice ??= client.getGasPrice();

            return gasPrice;
        },

        // the gas price is re-pinned whenever the block moved, for the same reason it was pinned:
        // pool state and gas price have to describe the same block
        async sync(source, toBlock) {
            const synced = await repository.sync(source, toBlock);

            if (synced.toBlock >= synced.fromBlock) {
                gasPrice = client.getGasPrice();
            }

            return { reshaped: synced.reshaped };
        },

        async readGasPricing(outputToken, gasPriceWei) {
            if (isSameAddress(outputToken, chain.wrappedNative)) {
                return { gasPriceWei, outputTokenPerNativeNumerator: 1n, outputTokenPerNativeDenominator: 1n };
            }

            const reference = repository
                .allConcentrated()
                .find(
                    (pool) =>
                        (isSameAddress(pool.token0, chain.wrappedNative) || isSameAddress(pool.token1, chain.wrappedNative)) &&
                        (isSameAddress(pool.token0, outputToken) || isSameAddress(pool.token1, outputToken)),
                );

            if (reference === undefined) {
                throw new Error(`No loaded pool prices gas in ${outputToken} on chain ${chain.id}`);
            }

            // sqrtPriceX96^2 / 2^192 is token1 per token0, so the rate inverts with the token ordering
            const squared = reference.sqrtPriceX96 * reference.sqrtPriceX96;

            return isSameAddress(reference.token0, outputToken)
                ? { gasPriceWei, outputTokenPerNativeNumerator: Q192, outputTokenPerNativeDenominator: squared }
                : { gasPriceWei, outputTokenPerNativeNumerator: squared, outputTokenPerNativeDenominator: Q192 };
        },

        originCosts: null,
    };
}

// solana is reached through routers that do their own routing, so there are no pools to discover
// and no repository. its liquidity is real and its prices are real; what it lacks here is a signer
// and a fork, which is why it can value a deposit but never pay one out.
function svmEnvironment(chain: Extract<ReturnType<typeof chainRegistry.get>, { vmType: "svm" }>): ChainEnvironment {
    const sources = createSourceRegistry([createJupiterSource(chain.id), createDflowSource(chain.id)]);
    const rates = new Map<string, Promise<GasPricing>>();

    return {
        chain,
        repository: null,
        sources,
        hubAssets: chain.hubTokens,
        hubTokens: chain.hubTokens.map(({ address }) => address),

        // spl decimals are fixed per mint and these are the canonical mints; wsol is 9, the two
        // stablecoins are 6. read from the registry rather than the chain because there is no rpc
        // client for solana here, and a wrong value would be caught by the cross-router agreement
        // check rather than going unnoticed.
        async readHubDecimals() {
            return new Map(chain.hubTokens.map(({ asset, address }) => [address, asset === "WSOL" ? 9 : 6]));
        },

        async pinnedGasPrice() {
            return LAMPORTS_PER_SIGNATURE;
        },

        // nothing is loaded for solana: every quote is a live router call already
        async sync() {
            return { reshaped: [] };
        },

        // the native to output rate is a real quote for one sol from the same routers that price the
        // deposit, so gas is denominated by the same liquidity the swap is.
        async readGasPricing(outputToken, gasPriceWei) {
            if (outputToken === chain.wrappedNative) {
                return { gasPriceWei, outputTokenPerNativeNumerator: 1n, outputTokenPerNativeDenominator: 1n };
            }

            let rate = rates.get(outputToken);

            if (rate === undefined) {
                rate = sources
                    .quoteAll({ chainId: chain.id, tokenIn: chain.wrappedNative, tokenOut: outputToken, amountIn: LAMPORTS_PER_SOL })
                    .then((round) => {
                        const best = round.quotes.reduce<bigint>((highest, quote) => (quote.amountOut > highest ? quote.amountOut : highest), 0n);

                        if (best === 0n) {
                            throw new Error(`No router prices sol in ${outputToken}`);
                        }

                        return { gasPriceWei, outputTokenPerNativeNumerator: best, outputTokenPerNativeDenominator: LAMPORTS_PER_SOL };
                    });
                rates.set(outputToken, rate);
            }

            return rate;
        },

        originCosts: {
            settlement: async () => SIGNATURES_PER_TRANSACTION,
            rebalance: async () => SIGNATURES_PER_TRANSACTION,
        },
    };
}

export function createChainEnvironment({
    client,
    chainId,
    blockNumber,
    now,
}: {
    client: PublicClient | null;
    chainId: number;
    blockNumber: bigint;
    now: () => number;
}): ChainEnvironment {
    const chain = chainRegistry.get(chainId);

    return chain.vmType === "evm" ? evmEnvironment(chain, client!, blockNumber, now) : svmEnvironment(chain);
}
