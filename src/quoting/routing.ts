import { isSameAddress } from "../lib/address";
import { type Address } from "viem";
import { logger } from "../lib/logger";
import { mulDiv } from "../lib/math";
import { type createPoolRepository } from "../chain/pool-repository";
import { type createSourceRegistry, type SourceFailure, type SwapQuote } from "../sources/source-registry";

export type GasPricing = { gasPriceWei: bigint; outputTokenPerNativeNumerator: bigint; outputTokenPerNativeDenominator: bigint };

export type PathLeg = {
    tokenIn: Address;
    tokenOut: Address;
    quote: SwapQuote;
};

// what a cross-chain quote crossed on. the origin legs are a valuation of the deposit, never
// executed by the solver: the user deposits on the origin and the solver pays out of destination
// inventory, so only the destination legs become a transaction.
export type Bridge = {
    asset: string;
    originChainId: number;
    originLegs: PathLeg[];
    originAmountOut: bigint;
    bridgedAmount: bigint;
    // what it costs the solver to put the deposit back to work. the fill leaves it long the deposited
    // token on the origin and short on the destination, and the first step of undoing that is the
    // origin-side swap into the hub asset. that swap is measured on an origin fork like any other.
    rebalanceGasUsed: bigint;
    rebalanceCostInOutputToken: bigint;
    // the deposit sits in escrow on the origin until the solver claims it. that claim is a
    // transaction the solver sends and pays for, and it exists only when chains are crossed.
    settlementGasUsed: bigint;
    settlementCostInOutputToken: bigint;
};

export type Path = {
    bridge: Bridge | null;
    legs: PathLeg[];
    amountOut: bigint;
    gasUsed: bigint;
    gasCostInOutputToken: bigint;
    netAmountOut: bigint;
};

type PathSearchResult = {
    best: Path | null;
    paths: Path[];
    failures: SourceFailure[];
    prunedHubs: string[];
    consideredHubs: string[];
};

type PathSearchParams = {
    sources: ReturnType<typeof createSourceRegistry>;
    // null for a chain reached through routers that do their own routing: there are no pools to
    // discover and no hubs to search, only sources to ask
    repository: ReturnType<typeof createPoolRepository> | null;
    chainId: number;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    hubTokens: readonly string[];
    // called after pools are loaded, because pricing gas in the output token needs a pool that
    // discovery has not fetched yet at the time the search is requested
    readGasPricing: (outputToken: string) => Promise<GasPricing>;
    // output comes from our own amm math, which is verified wei-exact against QuoterV2 on live
    // state. gas is the one thing the math cannot produce, so it is measured on chain and cached.
    gasForRoute: (legs: PathLeg[], amountIn: bigint) => Promise<bigint | null>;
};

// how many candidate routes get a real execution for gas. ranking uses our own amm math, which is
// verified wei-exact against QuoterV2, so only the shortlist needs measuring: executing every
// candidate cost 14.5s per quote against roughly 1.4s per route measured.
const MEASURED_PATH_LIMIT = 3;

export function gasCostIn(gasPricing: GasPricing, gasEstimate: bigint): bigint {
    return mulDiv({
        value: gasEstimate * gasPricing.gasPriceWei,
        multiplier: gasPricing.outputTokenPerNativeNumerator,
        denominator: gasPricing.outputTokenPerNativeDenominator,
    });
}

export async function findPaths({
    sources,
    repository,
    chainId,
    tokenIn,
    tokenOut,
    amountIn,
    hubTokens,
    readGasPricing,
    gasForRoute,
}: PathSearchParams): Promise<PathSearchResult> {
    const from = tokenIn as Address;
    const to = tokenOut as Address;
    const hubs = repository === null ? [] : (hubTokens.filter((hub) => !isSameAddress(hub, from) && !isSameAddress(hub, to)) as Address[]);

    if (repository !== null) {
        await repository.ensureAll([
            [from, to],
            ...hubs.flatMap((hub): [Address, Address][] => [
                [from, hub],
                [hub, to],
            ]),
        ]);
    }

    // a hub only helps if both of its legs have pools. discovery already answered that, so dead ends
    // are dropped before a single swap is priced rather than during the search.
    const reachable = hubs.filter((hub) => repository!.hasPools(from, hub) && repository!.hasPools(hub, to));
    const prunedHubs = hubs.filter((hub) => !reachable.includes(hub));
    const gasPricing = await readGasPricing(tokenOut);
    const failures: SourceFailure[] = [];

    async function quoteLeg(legIn: Address, legOut: Address, legAmountIn: bigint): Promise<SwapQuote[]> {
        if (legAmountIn <= 0n) {
            return [];
        }

        const round = await sources.quoteAll({ chainId, tokenIn: legIn, tokenOut: legOut, amountIn: legAmountIn });
        failures.push(...round.failures);

        return round.quotes;
    }

    const direct = (await quoteLeg(from, to, amountIn)).map((quote) => ({
        legs: [{ tokenIn: from, tokenOut: to, quote }],
        amountOut: quote.amountOut,
    }));

    const hopped = await Promise.all(
        reachable.map(async (hub) => {
            const firstLeg = await quoteLeg(from, hub, amountIn);
            const built = await Promise.all(
                firstLeg.map(async (first) => {
                    const secondLeg = await quoteLeg(hub, to, first.amountOut);

                    return secondLeg.map((second) => ({
                        legs: [
                            { tokenIn: from, tokenOut: hub, quote: first },
                            { tokenIn: hub, tokenOut: to, quote: second },
                        ],
                        amountOut: second.amountOut,
                    }));
                }),
            );

            return built.flat();
        }),
    );

    // shortlist on our own amm math before paying to execute anything. the math is verified
    // wei-exact against QuoterV2, so this loses no accuracy, and executing every candidate cost
    // 14.5s per quote against roughly 1.4s per path measured.
    const candidates = [...direct, ...hopped.flat()]
        .sort((a, b) => (b.amountOut === a.amountOut ? 0 : b.amountOut > a.amountOut ? 1 : -1))
        .slice(0, MEASURED_PATH_LIMIT);

    const gas: (bigint | null)[] = [];

    // sequential: a cache miss dry-runs against the fork, and those snapshot and revert shared state
    for (const candidate of candidates) {
        gas.push(await gasForRoute(candidate.legs, amountIn));
    }

    // a route whose gas could not be measured is one that cannot execute, so it is dropped
    const priced: Path[] = candidates.flatMap((candidate, index) => {
        const gasUsed = gas[index];

        if (gasUsed === null || gasUsed === undefined) {
            return [];
        }

        const gasCostInOutputToken = gasCostIn(gasPricing, gasUsed);

        return [{ bridge: null, ...candidate, gasUsed, gasCostInOutputToken, netAmountOut: candidate.amountOut - gasCostInOutputToken }];
    });

    priced.sort((a, b) => (b.netAmountOut === a.netAmountOut ? 0 : b.netAmountOut > a.netAmountOut ? 1 : -1));

    const best = priced[0] ?? null;

    logger.info("Paths Searched: ", {
        chainId,
        hubsViable: reachable.length,
        hubsPruned: prunedHubs.length,
        pathsFound: candidates.length,
        pathsExecutable: priced.length,
        failures: failures.length,
        winner:
            best === null
                ? null
                : {
                      hops: best.legs.length,
                      route: best.legs.map((leg) => leg.quote.sourceId).join(" -> "),
                      netAmountOut: best.netAmountOut.toString(),
                  },
    });

    return { best, paths: priced, failures, prunedHubs, consideredHubs: reachable };
}
