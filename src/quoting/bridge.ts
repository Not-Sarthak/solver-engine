import { isSameAddress } from "../lib/address";
import { type Address } from "viem";
import { type ChainEnvironment } from "./environment";
import { logger } from "../lib/logger";
import { convertDecimals, mulDiv } from "../lib/math";
import { findPaths, gasCostIn, type Bridge, type Path, type PathLeg } from "./routing";

type BridgeSearchResult = {
    best: Path | null;
    paths: Path[];
    commonAssets: string[];
};

type BridgeSearchParams = {
    origin: ChainEnvironment;
    destination: ChainEnvironment;
    tokenIn: string;
    tokenOut: string;
    amountIn: bigint;
    gasForRoute: (legs: PathLeg[], amountIn: bigint) => Promise<bigint | null>;
    gasForPayout: (token: Address, amount: bigint) => Promise<bigint | null>;
    // origin-side costs are null when the origin has neither a fork to measure on nor a fee model
    gasForRebalance: ((legs: PathLeg[], amountIn: bigint) => Promise<bigint | null>) | null;
    gasForSettlement: ((token: Address, amount: bigint) => Promise<bigint | null>) | null;
};

// a cross-chain fill is not a bridge transaction. the user deposits on the origin and the solver
// pays out of inventory it already holds on the destination, then reclaims the deposit at
// settlement. so the origin side is a valuation of what the deposit will be worth, and only the
// destination side becomes a transaction the solver signs and pays gas for.
//
// the two sides are joined on a hub asset that both chains carry, held at one to one across the
// bridge. that is the single assumption in the model and it is the same one every fill-then-settle
// solver makes: usdc on base and usdc on arbitrum are the same dollar, so the solver is indifferent
// to which side it holds. the assets are matched on a curated label rather than on symbol, because
// tether's arbitrum token reports USD~0 rather than USDT.
export async function findBridgedPaths({
    origin,
    destination,
    tokenIn,
    tokenOut,
    amountIn,
    gasForRoute,
    gasForPayout,
    gasForRebalance,
    gasForSettlement,
}: BridgeSearchParams): Promise<BridgeSearchResult> {
    const shared = origin.hubAssets.filter((candidate) => destination.hubAssets.some((other) => other.asset === candidate.asset));
    const [originDecimals, destinationDecimals] = await Promise.all([origin.readHubDecimals(), destination.readHubDecimals()]);
    const [originGasPrice, destinationGasPrice] = await Promise.all([origin.pinnedGasPrice(), destination.pinnedGasPrice()]);
    // claiming the deposit costs the same whichever hub asset the search settles on, because it is
    // the deposited token that moves. measuring it once keeps it out of the per-asset loop.
    if (gasForSettlement === null) {
        logger.warn("Settlement Not Measurable: ", { originChainId: origin.chain.id });

        return { best: null, paths: [], commonAssets: shared.map(({ asset }) => asset) };
    }

    const settlementGasUsed = await gasForSettlement(tokenIn as Address, amountIn);

    if (settlementGasUsed === null) {
        return { best: null, paths: [], commonAssets: shared.map(({ asset }) => asset) };
    }

    const paths: Path[] = [];

    for (const { asset } of shared) {
        const originHub = origin.hubAssets.find((candidate) => candidate.asset === asset)!.address as Address;
        const destinationHub = destination.hubAssets.find((candidate) => candidate.asset === asset)!.address as Address;

        let originLegs: PathLeg[] = [];
        let originAmountOut = amountIn;

        // the deposit only has to be valued, not swapped: the solver never signs anything on the
        // origin chain at fill time. the cost of actually converting it later is rebalancing, which
        // is priced separately, so this search carries no gas of its own.
        if (!isSameAddress(tokenIn, originHub)) {
            const valuation = await findPaths({
                sources: origin.sources,
                repository: origin.repository,
                chainId: origin.chain.id,
                tokenIn,
                tokenOut: originHub,
                amountIn,
                hubTokens: [...origin.hubTokens],
                readGasPricing: (token: string) => origin.readGasPricing(token, originGasPrice),
                gasForRoute: async () => 0n,
            });

            if (valuation.best === null) {
                continue;
            }

            originLegs = valuation.best.legs;
            originAmountOut = valuation.best.amountOut;
        }

        // the deposit arrives as tokenIn on the origin and has to become the hub asset before the
        // solver can redeploy it. that swap has not happened yet, so its gas is not part of the fill,
        // but it is owed and it is measurable. a deposit that already is the hub asset owes nothing.
        let rebalanceGasUsed = 0n;

        if (originLegs.length > 0) {
            if (gasForRebalance === null) {
                logger.warn("Rebalance Not Measurable: ", { asset, originChainId: origin.chain.id });
                continue;
            }

            const measured = await gasForRebalance(originLegs, amountIn);

            if (measured === null) {
                continue;
            }

            rebalanceGasUsed = measured;
        }

        // keyed by the registry address as written, never lower cased: an evm address is already
        // lower case there, and a base58 mint is case sensitive, so lower casing it names nothing
        const originHubDecimals = originDecimals.get(originHub)!;
        const destinationHubDecimals = destinationDecimals.get(destinationHub)!;
        const bridgedAmount = convertDecimals({ value: originAmountOut, fromDecimals: originHubDecimals, toDecimals: destinationHubDecimals });

        if (bridgedAmount <= 0n) {
            continue;
        }

        // origin gas is paid in origin native and the quote is denominated in the destination output
        // token, so it is carried across the same way value is: priced into the hub asset on the
        // origin, restated in the destination hub's decimals, then scaled by whatever the destination
        // leg turns hub into output at. a pure bridge scales by one, because hub is the output.
        // a deposit that already is the hub asset skips the origin search, so nothing has loaded an
        // origin pool yet, and pricing origin gas needs the one pairing the hub with the native token.
        // the destination side had the same hole; without this it only worked when another hub asset
        // had already searched the origin and loaded it by chance.
        await origin.repository?.ensureAll([[origin.chain.wrappedNative as Address, originHub]]);

        const originPricing = await origin.readGasPricing(originHub, originGasPrice);
        const carry = (originGas: bigint) =>
            convertDecimals({
                value: gasCostIn(originPricing, originGas),
                fromDecimals: originHubDecimals,
                toDecimals: destinationHubDecimals,
            });

        const rebalanceInDestinationHub = carry(rebalanceGasUsed);
        const settlementInDestinationHub = carry(settlementGasUsed);

        const bridge: Bridge = {
            asset,
            originChainId: origin.chain.id,
            originLegs,
            originAmountOut,
            bridgedAmount,
            rebalanceGasUsed,
            rebalanceCostInOutputToken: 0n,
            settlementGasUsed,
            settlementCostInOutputToken: 0n,
        };

        // the user asked for the very asset the solver already holds on the destination, so there is
        // nothing to swap and the fill is the payout itself.
        if (isSameAddress(destinationHub, tokenOut)) {
            const gasUsed = await gasForPayout(tokenOut as Address, bridgedAmount);

            if (gasUsed === null) {
                continue;
            }

            // a pure bridge never searches the destination, so nothing has loaded a pool there yet.
            // gas still has to be priced in the output token, and that needs the pool pairing it with
            // the native token. without this the branch only worked when some other hub asset had
            // already searched the destination and loaded it by chance.
            await destination.repository?.ensureAll([[destination.chain.wrappedNative as Address, tokenOut as Address]]);

            const gasCostInOutputToken = gasCostIn(await destination.readGasPricing(tokenOut, destinationGasPrice), gasUsed);

            paths.push({
                bridge: {
                    ...bridge,
                    rebalanceCostInOutputToken: rebalanceInDestinationHub,
                    settlementCostInOutputToken: settlementInDestinationHub,
                },
                legs: [],
                amountOut: bridgedAmount,
                gasUsed,
                gasCostInOutputToken,
                netAmountOut: bridgedAmount - gasCostInOutputToken - rebalanceInDestinationHub - settlementInDestinationHub,
            });

            continue;
        }

        const fill = await findPaths({
            sources: destination.sources,
            repository: destination.repository,
            chainId: destination.chain.id,
            tokenIn: destinationHub,
            tokenOut,
            amountIn: bridgedAmount,
            hubTokens: [...destination.hubTokens],
            readGasPricing: (token: string) => destination.readGasPricing(token, destinationGasPrice),
            gasForRoute,
        });

        if (fill.best !== null) {
            // both origin costs were priced in the hub asset, and the destination leg is what turns
            // hub into the output token, so they are restated at the rate that leg achieved.
            const best = fill.best;
            const inOutputToken = (inDestinationHub: bigint) =>
                mulDiv({ value: inDestinationHub, multiplier: best.amountOut, denominator: bridgedAmount });
            const rebalanceCostInOutputToken = inOutputToken(rebalanceInDestinationHub);
            const settlementCostInOutputToken = inOutputToken(settlementInDestinationHub);

            paths.push({
                ...best,
                bridge: { ...bridge, rebalanceCostInOutputToken, settlementCostInOutputToken },
                netAmountOut: best.netAmountOut - rebalanceCostInOutputToken - settlementCostInOutputToken,
            });
        }
    }

    paths.sort((a, b) => (b.netAmountOut === a.netAmountOut ? 0 : b.netAmountOut > a.netAmountOut ? 1 : -1));

    const best = paths[0] ?? null;

    logger.info("Bridge Searched: ", {
        originChainId: origin.chain.id,
        destinationChainId: destination.chain.id,
        commonAssets: shared.map(({ asset }) => asset),
        pathsFound: paths.length,
        winner:
            best === null
                ? null
                : {
                      asset: best.bridge!.asset,
                      destinationHops: best.legs.length,
                      rebalanceGas: best.bridge!.rebalanceGasUsed.toString(),
                      settlementGas: best.bridge!.settlementGasUsed.toString(),
                      netAmountOut: best.netAmountOut.toString(),
                  },
    });

    return { best, paths, commonAssets: shared.map(({ asset }) => asset) };
}
