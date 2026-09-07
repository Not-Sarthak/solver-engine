import { type Address, type PublicClient } from "viem";
import { concentratedLiquiditySchema } from "../sources/concentrated-liquidity";
import { uniswapV2PairAbi, uniswapV3PoolAbi } from "./abis";
import { chunkedMulticall } from "./multicall";

// which deployment a pool came from. read separately from its state, because the state comes off the
// contract and the origin comes from the registry entry that derived its address.
type PoolOrigin = {
    ammId: string;
    router: Address;
    feeBps: bigint;
};

type ConstantProductPoolState = {
    address: Address;
    token0: Address;
    token1: Address;
    reserve0: bigint;
    reserve1: bigint;
    blockNumber: bigint;
};

type ConcentratedPoolState = {
    address: Address;
    token0: Address;
    token1: Address;
    sqrtPriceX96: bigint;
    liquidity: bigint;
    tick: number;
    tickSpacing: number;
    feePips: bigint;
    ticks: { index: number; liquidityNet: bigint }[];
    blockNumber: bigint;
};

type ReadPoolParams = { client: PublicClient; address: Address; wordRange: number; blockNumber: bigint };

export type LoadedConstantProductPool = ConstantProductPoolState & PoolOrigin;

export type LoadedConcentratedPool = ConcentratedPoolState & PoolOrigin;

const TICKS_PER_WORD = 256;

// v3 records which ticks are initialised as bits in 256-bit words rather than a list, so finding
// them means reading the words around the current price and decoding every set bit.
export async function readConstantProductPool({
    client,
    address,
    blockNumber,
}: Omit<ReadPoolParams, "wordRange">): Promise<ConstantProductPoolState> {
    const pair = { address: address as Address, abi: uniswapV2PairAbi } as const;
    const [reserves, token0, token1] = await client.multicall({
        contracts: [
            { ...pair, functionName: "getReserves" },
            { ...pair, functionName: "token0" },
            { ...pair, functionName: "token1" },
        ],
        allowFailure: false,
        blockNumber,
    });

    return { address: address as Address, token0, token1, reserve0: reserves[0], reserve1: reserves[1], blockNumber };
}

export async function readConcentratedPool({ client, address, wordRange, blockNumber }: ReadPoolParams): Promise<ConcentratedPoolState> {
    const pool = { address: address as Address, abi: uniswapV3PoolAbi } as const;
    const [slot0, liquidity, fee, tickSpacing, token0, token1] = await client.multicall({
        contracts: [
            { ...pool, functionName: "slot0" },
            { ...pool, functionName: "liquidity" },
            { ...pool, functionName: "fee" },
            { ...pool, functionName: "tickSpacing" },
            { ...pool, functionName: "token0" },
            { ...pool, functionName: "token1" },
        ],
        allowFailure: false,
        blockNumber,
    });

    const currentTick = slot0[1];
    const compressed = Math.floor(currentTick / tickSpacing);
    const centreWord = compressed >> 8;
    const wordPositions = Array.from({ length: wordRange * 2 + 1 }, (_, offset) => centreWord - wordRange + offset);

    const words = await chunkedMulticall<bigint>(
        client,
        wordPositions.map((wordPosition) => ({ ...pool, functionName: "tickBitmap" as const, args: [wordPosition] as const })),
        blockNumber,
    );

    // every set bit in a word is an initialised tick, at (word * 256 + bit) * tickSpacing
    const initialised = wordPositions.flatMap((wordPosition, index) => {
        const word = words[index]!;
        const found: number[] = [];

        for (let bit = 0; bit < TICKS_PER_WORD; bit++) {
            if ((word >> BigInt(bit)) & 1n) {
                found.push((wordPosition * TICKS_PER_WORD + bit) * tickSpacing);
            }
        }

        return found;
    });
    const tickData = await chunkedMulticall<readonly [bigint, bigint, bigint, bigint, bigint, bigint, number, boolean]>(
        client,
        initialised.map((index) => ({ ...pool, functionName: "ticks" as const, args: [index] as const })),
        blockNumber,
    );

    // sorted once, here, because the swap loop binary-searches this list and then walks a cursor
    // through it. this is also where the pool is validated: the check is O(ticks) and the data
    // crosses the rpc boundary exactly once, whereas a quote swaps against it repeatedly.
    const ticks = initialised
        .map((index, position) => ({ index, liquidityNet: tickData[position]![1] }))
        .sort((left, right) => left.index - right.index);

    const state = {
        sqrtPriceX96: slot0[0],
        liquidity,
        tick: currentTick,
        tickSpacing,
        feePips: BigInt(fee),
        ticks,
    };
    concentratedLiquiditySchema.pool.parse(state);

    return { address: address as Address, token0, token1, ...state, blockNumber };
}
