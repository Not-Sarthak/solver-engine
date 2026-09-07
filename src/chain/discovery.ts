import { isSameAddress } from "../lib/address";
import { encodeAbiParameters, encodePacked, getCreate2Address, keccak256, type Address, type Hex, type PublicClient } from "viem";
import { chainRegistry, checksum, type ChainConfig } from "./chain-registry";
import { uniswapV2PairAbi, uniswapV3PoolAbi } from "./abis";

type PoolKind = "v2" | "v3";

type PoolCandidate = {
    kind: PoolKind;
    // which deployment this came from, and the router that can trade it. two amms can hold the same
    // pair at the same fee and they are not interchangeable: each pool only exists in its own
    // factory, and only its own router knows how to reach it.
    ammId: string;
    router: Address;
    address: Address;
    chainId: number;
    token0: Address;
    token1: Address;
    feeTier: number;
    feeBps: bigint;
};

// a candidate that exists on chain, with the cheap number pools are ranked on: in-range liquidity
// for v3, the smaller reserve for v2. the tick is what a later mint is judged in-range against;
// a v2 pair has none.
export type LivePool = PoolCandidate & { liquidity: bigint; tick: number | null };

type DiscoverParams = { client: PublicClient; chainId: number; tokenA: Address; tokenB: Address; blockNumber: bigint };

export function sortTokens(tokenA: Address, tokenB: Address): [Address, Address] {
    return tokenA.toLowerCase() < tokenB.toLowerCase() ? [tokenA, tokenB] : [tokenB, tokenA];
}

// uniswap deploys pools with CREATE2, so every pool address is a pure function of the pair, the fee
// tier and the factory. no subgraph, no factory call, no hardcoded pool list. a fork changes only
// the factory and the init code hash, which is why an amm is a registry entry rather than a module.
export function candidatePools(chain: ChainConfig, tokenA: Address, tokenB: Address): PoolCandidate[] {
    const [token0, token1] = sortTokens(checksum(tokenA), checksum(tokenB));

    if (isSameAddress(token0, token1)) {
        return [];
    }

    return chain.amms.flatMap((amm): PoolCandidate[] => {
        const common = { ammId: amm.id, router: checksum(amm.router), chainId: chain.id, token0, token1 };

        if (amm.kind === "v2") {
            return [
                {
                    ...common,
                    kind: "v2",
                    feeTier: Number(amm.feeBps),
                    feeBps: amm.feeBps,
                    address: getCreate2Address({
                        from: checksum(amm.factory),
                        salt: keccak256(encodePacked(["address", "address"], [token0, token1])),
                        bytecodeHash: amm.initCodeHash as Hex,
                    }),
                },
            ];
        }

        return amm.feeTiers.map((feeTier) => ({
            ...common,
            kind: "v3" as const,
            feeTier,
            feeBps: 0n,
            address: getCreate2Address({
                from: checksum(amm.deployer),
                salt: keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "uint24" }], [token0, token1, feeTier])),
                bytecodeHash: amm.initCodeHash as Hex,
            }),
        }));
    });
}

// every candidate that answers is a pool that exists, empty or not. an empty one is returned with
// zero liquidity rather than dropped: it is never quoted against, but it is watched, because the
// mint that fills it is an event and not a reason to probe again.
export async function discoverPools({ client, chainId, tokenA, tokenB, blockNumber }: DiscoverParams): Promise<LivePool[]> {
    const candidates = candidatePools(chainRegistry.get(chainId), tokenA, tokenB);
    const contracts = candidates.flatMap(
        (candidate): { address: Address; abi: typeof uniswapV2PairAbi | typeof uniswapV3PoolAbi; functionName: string }[] =>
            candidate.kind === "v2"
                ? [{ address: candidate.address, abi: uniswapV2PairAbi, functionName: "getReserves" }]
                : [
                      { address: candidate.address, abi: uniswapV3PoolAbi, functionName: "liquidity" },
                      { address: candidate.address, abi: uniswapV3PoolAbi, functionName: "slot0" },
                  ],
    );
    const results = await client.multicall({ contracts, allowFailure: true, blockNumber });

    // every probe failing is ambiguous: a pair with no pools at all looks exactly like an rpc that
    // answered nothing, because viem reports a transport failure as a failed result for the whole
    // batch. inferring an outage from it reported "the rpc did not answer" for any unlisted pair, so
    // the question is asked directly instead, with one call, only on the path where it is unclear.
    if (results.every((result) => result?.status === "failure")) {
        await client.getBlockNumber().catch((cause: unknown) => {
            throw new Error(`Every pool probe failed for ${tokenA}/${tokenB} on chain ${chainId} and the rpc is unreachable`, { cause });
        });
    }

    const live: LivePool[] = [];
    let cursor = 0;

    for (const candidate of candidates) {
        if (candidate.kind === "v2") {
            const result = results[cursor++];

            if (result?.status === "success") {
                const [reserve0, reserve1] = result.result as readonly [bigint, bigint, number];

                live.push({ ...candidate, liquidity: reserve0 < reserve1 ? reserve0 : reserve1, tick: null });
            }

            continue;
        }

        const liquidity = results[cursor++];
        const slot0 = results[cursor++];

        if (liquidity?.status === "success" && slot0?.status === "success") {
            live.push({
                ...candidate,
                liquidity: liquidity.result as bigint,
                tick: (slot0.result as readonly [bigint, number, number, number, number, number, boolean])[1],
            });
        }
    }

    return live;
}
