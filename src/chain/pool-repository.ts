import { type Address, type PublicClient } from "viem";
import { factoryEventsAbi, poolEventsAbi } from "./abis";
import { isSameAddress } from "../lib/address";
import { logger } from "../lib/logger";
import { chainRegistry } from "./chain-registry";
import { getLogsInRanges } from "./client";
import { candidatePools, discoverPools, sortTokens, type LivePool } from "./discovery";
import { readConcentratedPool, readConstantProductPool, type LoadedConcentratedPool, type LoadedConstantProductPool } from "./pools";

// a pair holds every pool of it that exists (`tracked`, with the cheap number pools are ranked
// on kept exact by events) and full state for the deepest few (`constantProduct`, `concentrated`).
type LoadedPair = {
    key: string;
    token0: Address;
    token1: Address;
    tracked: LivePool[];
    constantProduct: LoadedConstantProductPool[];
    concentrated: LoadedConcentratedPool[];
    blockNumber: bigint;
    loadedAtMs: number;
};

type PoolRepositoryParams = { client: PublicClient; chainId: number; blockNumber: bigint; now: () => number };

// `reshaped` names the pools whose liquidity structure changed (a mint, a burn, a creation): a
// route through one of them may cost different gas now, or work where it did not
type SyncResult = { fromBlock: bigint; toBlock: bigint; events: number; reshaped: Address[] };

type PoolLog = Awaited<ReturnType<PublicClient["getLogs"]>>[number] & {
    blockNumber: bigint;
} & (
        | { eventName: "Swap"; args: { sqrtPriceX96: bigint; liquidity: bigint; tick: number } }
        | { eventName: "Mint"; args: { tickLower: number; tickUpper: number; amount: bigint } }
        | { eventName: "Burn"; args: { tickLower: number; tickUpper: number; amount: bigint } }
        | { eventName: "Sync"; args: { reserve0: bigint; reserve1: bigint } }
        | { eventName: "Initialize"; args: { sqrtPriceX96: bigint; tick: number } }
    );

type FactoryLog = Awaited<ReturnType<PublicClient["getLogs"]>>[number] & {
    blockNumber: bigint;
} & (
        | { eventName: "PoolCreated"; args: { token0: Address; token1: Address; fee: number; pool: Address } }
        | { eventName: "PairCreated"; args: { token0: Address; token1: Address; pair: Address } }
    );

// measured against QuoterV2: a tick window of 8 words either side is exact at every size up to
// 200M USDC, and 1 overstates by 7315 bps at 200M. 3 pools per pair is exact; 2 loses 4 bps on
// small trades. coverage is nearly free: 8 words loaded in 1094ms against 779ms for none.
const TICK_WORD_RANGE = 8;

const POOLS_PER_PAIR = 3;

// discovery returns liquidity cheaply; full v3 state with its tick bitmap costs the better part of a
// second per pool. so rank on the cheap number first and only pay for the deepest few, which is the
// same candidate-selection step uniswap's own router does before it quotes anything.
function deepest(pools: LivePool[], limit: number): LivePool[] {
    return pools
        .filter((pool) => pool.liquidity > 0n)
        .sort((a, b) => (b.liquidity === a.liquidity ? 0 : b.liquidity > a.liquidity ? 1 : -1))
        .slice(0, limit);
}

function pairKey(chainId: number, tokenA: Address, tokenB: Address): string {
    const [token0, token1] = sortTokens(tokenA, tokenB);

    return `${chainId}:${token0.toLowerCase()}:${token1.toLowerCase()}`;
}

// keeps the ranking number of any existing pool exact without holding its ticks. a swap reports
// in-range liquidity and the tick outright; a mint or burn is in range or not against the tick the
// last swap or the initialisation left, which cannot have moved since, because only swaps move it.
function applyToTracked(pool: LivePool, log: PoolLog): LivePool {
    if (log.eventName === "Sync") {
        return { ...pool, liquidity: log.args.reserve0 < log.args.reserve1 ? log.args.reserve0 : log.args.reserve1 };
    }

    if (log.eventName === "Swap") {
        return { ...pool, liquidity: log.args.liquidity, tick: log.args.tick };
    }

    if (log.eventName === "Initialize") {
        return { ...pool, tick: log.args.tick };
    }

    const inRange = pool.tick !== null && log.args.tickLower <= pool.tick && pool.tick < log.args.tickUpper;

    return inRange ? { ...pool, liquidity: pool.liquidity + (log.eventName === "Mint" ? log.args.amount : -log.args.amount) } : pool;
}

// applies one pool event to a loaded pool, in log order. a swap's event carries the pool's exact
// post state; a mint or burn moves liquidity at its two ticks and, when the current tick is inside
// the range, in the pool. a tick whose net goes to zero is left in place: crossing it changes
// nothing, which is what the pool does too.
function applyToConcentrated(pool: LoadedConcentratedPool, log: PoolLog): LoadedConcentratedPool {
    if (log.eventName === "Swap") {
        return { ...pool, sqrtPriceX96: log.args.sqrtPriceX96, liquidity: log.args.liquidity, tick: log.args.tick, blockNumber: log.blockNumber };
    }

    if (log.eventName === "Initialize") {
        return { ...pool, sqrtPriceX96: log.args.sqrtPriceX96, tick: log.args.tick, blockNumber: log.blockNumber };
    }

    if (log.eventName !== "Mint" && log.eventName !== "Burn") {
        return pool;
    }

    const { tickLower, tickUpper, amount } = log.args;
    const delta = log.eventName === "Mint" ? amount : -amount;
    const ticks = [...pool.ticks];

    for (const [index, sign] of [
        [tickLower, 1n],
        [tickUpper, -1n],
    ] as const) {
        const position = ticks.findIndex((tick) => tick.index >= index);

        if (position !== -1 && ticks[position]!.index === index) {
            ticks[position] = { index, liquidityNet: ticks[position]!.liquidityNet + sign * delta };
        } else {
            ticks.splice(position === -1 ? ticks.length : position, 0, { index, liquidityNet: sign * delta });
        }
    }

    const inRange = tickLower <= pool.tick && pool.tick < tickUpper;

    return { ...pool, ticks, liquidity: inRange ? pool.liquidity + delta : pool.liquidity, blockNumber: log.blockNumber };
}

export function createPoolRepository({ client, chainId, blockNumber, now }: PoolRepositoryParams) {
    const chain = chainRegistry.get(chainId);
    const loaded = new Map<string, LoadedPair>();
    const inFlight = new Map<string, Promise<LoadedPair>>();
    // the block every loaded pool is current to. loads read at the pinned block; sync moves the
    // whole repository forward from there by replaying the pools' own events.
    let syncedBlock = blockNumber;
    // a sync still running when the next block fires would replay the same range twice, and a mint
    // applied twice is liquidity that does not exist. the later call joins the earlier one.
    let syncing: Promise<SyncResult> | null = null;

    // full state for a selection of pools, read from one chain at one block. what was already
    // loaded and is still selected is kept as it is, because sync has been keeping it current.
    async function readSelected(
        from: PublicClient,
        selected: LivePool[],
        keep: Pick<LoadedPair, "constantProduct" | "concentrated">,
        atBlock: bigint,
    ) {
        const [constantProduct, concentrated] = await Promise.all([
            Promise.all(
                selected
                    .filter((pool) => pool.kind === "v2")
                    .map(
                        async (pool) =>
                            keep.constantProduct.find((known) => isSameAddress(known.address, pool.address)) ?? {
                                ...(await readConstantProductPool({ client: from, address: pool.address, blockNumber: atBlock })),
                                ammId: pool.ammId,
                                router: pool.router,
                                feeBps: pool.feeBps,
                            },
                    ),
            ),
            Promise.all(
                selected
                    .filter((pool) => pool.kind === "v3")
                    .map(
                        async (pool) =>
                            keep.concentrated.find((known) => isSameAddress(known.address, pool.address)) ?? {
                                ...(await readConcentratedPool({
                                    client: from,
                                    address: pool.address,
                                    wordRange: TICK_WORD_RANGE,
                                    blockNumber: atBlock,
                                })),
                                ammId: pool.ammId,
                                router: pool.router,
                                feeBps: pool.feeBps,
                            },
                    ),
            ),
        ]);

        return { constantProduct, concentrated };
    }

    async function load(tokenA: Address, tokenB: Address): Promise<LoadedPair> {
        const key = pairKey(chainId, tokenA, tokenB);
        const [token0, token1] = sortTokens(tokenA, tokenB);
        const startedAt = Bun.nanoseconds();
        const tracked = await discoverPools({ client, chainId, tokenA, tokenB, blockNumber });
        const selected = deepest(tracked, POOLS_PER_PAIR);
        const state = await readSelected(client, selected, { constantProduct: [], concentrated: [] }, blockNumber);
        const entry: LoadedPair = { key, token0, token1, tracked, ...state, blockNumber, loadedAtMs: now() };

        loaded.set(key, entry);

        logger.info("Pair Loaded: ", {
            key,
            discovered: tracked.length,
            loaded: selected.length,
            ticks: state.concentrated.reduce((total, pool) => total + pool.ticks.length, 0),
            durationMs: Number(((Bun.nanoseconds() - startedAt) / 1_000_000).toFixed(1)),
        });

        return entry;
    }

    // concurrent quotes for the same pair must not each trigger their own discovery
    async function ensure(tokenA: Address, tokenB: Address): Promise<LoadedPair> {
        const key = pairKey(chainId, tokenA, tokenB);
        const cached = loaded.get(key);

        if (cached !== undefined) {
            return cached;
        }

        const pending = inFlight.get(key);

        if (pending !== undefined) {
            return pending;
        }

        const started = load(tokenA, tokenB).finally(() => inFlight.delete(key));
        inFlight.set(key, started);

        return started;
    }

    async function ensureAll(pairs: readonly (readonly [Address, Address])[]): Promise<void> {
        await Promise.all(pairs.map(([tokenA, tokenB]) => ensure(tokenA, tokenB)));
    }

    function allConstantProduct(): LoadedConstantProductPool[] {
        return [...loaded.values()].flatMap((entry) => entry.constantProduct);
    }

    function allConcentrated(): LoadedConcentratedPool[] {
        return [...loaded.values()].flatMap((entry) => entry.concentrated);
    }

    function hasPools(tokenA: Address, tokenB: Address): boolean {
        const entry = loaded.get(pairKey(chainId, tokenA, tokenB));

        return entry !== undefined && entry.constantProduct.length + entry.concentrated.length > 0;
    }

    // a pool that came into existence for a pair that is loaded. its address is checked against
    // the pair's own candidates, so a factory's event for a pool this registry does not describe
    // is ignored rather than trusted.
    function track(pair: LoadedPair, log: FactoryLog): LoadedPair {
        const created = log.eventName === "PoolCreated" ? log.args.pool : log.args.pair;

        if (pair.tracked.some((pool) => isSameAddress(pool.address, created))) {
            return pair;
        }

        const candidate = candidatePools(chain, pair.token0, pair.token1).find((known) => isSameAddress(known.address, created));

        if (candidate === undefined) {
            return pair;
        }

        logger.info("Pool Created: ", {
            key: pair.key,
            ammId: candidate.ammId,
            feeTier: candidate.feeTier,
            address: created,
            blockNumber: log.blockNumber.toString(),
        });

        return { ...pair, tracked: [...pair.tracked, { ...candidate, liquidity: 0n, tick: null }] };
    }

    function applyPoolLog(pair: LoadedPair, log: PoolLog): LoadedPair {
        return {
            ...pair,
            blockNumber: log.blockNumber,
            tracked: pair.tracked.map((pool) => (isSameAddress(pool.address, log.address) ? applyToTracked(pool, log) : pool)),
            constantProduct: pair.constantProduct.map((pool) =>
                isSameAddress(pool.address, log.address) && log.eventName === "Sync"
                    ? { ...pool, reserve0: log.args.reserve0, reserve1: log.args.reserve1, blockNumber: log.blockNumber }
                    : pool,
            ),
            concentrated: pair.concentrated.map((pool) => (isSameAddress(pool.address, log.address) ? applyToConcentrated(pool, log) : pool)),
        };
    }

    // the deepest pools may have changed hands: one that was watched but not loaded is now deeper
    // than one that was, or a pool created since boot has been filled. the promoted ones are read
    // in full from the chain the events came from, at the synced block, because that is the only
    // chain that has them there; the demoted ones are dropped, though still watched.
    async function reselect(source: PublicClient, pair: LoadedPair, atBlock: bigint): Promise<LoadedPair> {
        const selected = deepest(pair.tracked, POOLS_PER_PAIR);
        const held = [...pair.constantProduct, ...pair.concentrated].map((pool) => pool.address.toLowerCase());
        const wanted = selected.map((pool) => pool.address.toLowerCase());

        if (held.length === wanted.length && held.every((address) => wanted.includes(address))) {
            return pair;
        }

        const state = await readSelected(source, selected, pair, atBlock);

        logger.info("Pools Reselected: ", {
            key: pair.key,
            promoted: wanted.filter((address) => !held.includes(address)),
            demoted: held.filter((address) => !wanted.includes(address)),
            blockNumber: atBlock.toString(),
        });

        return { ...pair, ...state, blockNumber: atBlock };
    }

    // pool state moves with every swap, mint and burn, and a quote read from stale state is a quote
    // for a pool that no longer exists. rather than reloading ticks (about a second per pool), the
    // pools' own events are replayed: they carry the exact post state, so the result is what a
    // fresh read at `toBlock` would return. the factories are read in the same pass, so a pool
    // created after boot is watched from its first block. one getLogs each per chain per sync.
    // the client is whichever chain the fills land on, because that is the state that moved.
    function sync(source: PublicClient, toBlock: bigint): Promise<SyncResult> {
        if (syncing === null) {
            syncing = replay(source, toBlock).finally(() => (syncing = null));
        }

        return syncing;
    }

    async function replay(source: PublicClient, toBlock: bigint): Promise<SyncResult> {
        const fromBlock = syncedBlock + 1n;

        if (toBlock < fromBlock || loaded.size === 0) {
            return { fromBlock, toBlock, events: 0, reshaped: [] };
        }

        const factories = chain.amms.map((amm) => amm.factory as Address);
        const created = await getLogsInRanges<FactoryLog>(source, { address: factories, events: factoryEventsAbi, fromBlock, toBlock, strict: true });

        for (const log of created) {
            const key = pairKey(chainId, log.args.token0, log.args.token1);
            const pair = loaded.get(key);

            if (pair !== undefined) {
                loaded.set(key, track(pair, log));
            }
        }

        const addresses = [...loaded.values()].flatMap((pair) => pair.tracked.map((pool) => pool.address));
        const logs =
            addresses.length === 0
                ? []
                : await getLogsInRanges<PoolLog>(source, { address: addresses, events: poolEventsAbi, fromBlock, toBlock, strict: true });

        const reshaped = new Set<Address>(created.map((log) => (log.eventName === "PoolCreated" ? log.args.pool : log.args.pair)));

        for (const log of logs) {
            if (log.eventName === "Mint" || log.eventName === "Burn") {
                reshaped.add(log.address);
            }

            for (const [key, pair] of loaded) {
                if (pair.tracked.some((pool) => isSameAddress(pool.address, log.address))) {
                    loaded.set(key, applyPoolLog(pair, log));
                }
            }
        }

        for (const [key, pair] of loaded) {
            loaded.set(key, await reselect(source, pair, toBlock));
        }

        syncedBlock = toBlock;

        if (logs.length > 0 || created.length > 0) {
            logger.info("Pools Synced: ", {
                chainId,
                fromBlock: fromBlock.toString(),
                toBlock: toBlock.toString(),
                events: logs.length,
                created: created.length,
                pools: addresses.length,
            });
        }

        return { fromBlock, toBlock, events: logs.length + created.length, reshaped: [...reshaped] };
    }

    return {
        ensure,
        ensureAll,
        hasPools,
        allConstantProduct,
        allConcentrated,
        sync,
        syncedBlock: () => syncedBlock,
        loadedPairs: () => [...loaded.keys()],
        tracked: (tokenA: Address, tokenB: Address) => loaded.get(pairKey(chainId, tokenA, tokenB))?.tracked ?? [],
        invalidate: () => loaded.clear(),
    };
}
