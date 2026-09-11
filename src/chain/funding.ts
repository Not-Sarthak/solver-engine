import { parseUnits } from "viem";
import type { Address, PublicClient, TestClient } from "viem";
import { logger } from "../lib/logger";
import { erc20Abi } from "./abis";
import { dealToken } from "./deal";
import type { ChainConfig } from "./chain-registry";

export type Holding = { chainId: number; token: string; amount: bigint };

type FundingParams = { chain: ChainConfig; publicClient: PublicClient; testClient: TestClient; account: Address; unitsPerToken: string };

// inventory is written straight into token storage rather than bought on the market. buying would
// move the very pools the solver is about to quote, and then the fork would no longer match the
// block the quotes were read at.
export async function fundInventory({ chain, publicClient, testClient, account, unitsPerToken }: FundingParams): Promise<Holding[]> {
    const owner = account;
    const decimals = await publicClient.multicall({
        contracts: chain.hubTokens.map(({ address }) => ({ address: address as Address, abi: erc20Abi, functionName: "decimals" as const })),
        allowFailure: false,
    });

    const holdings: Holding[] = [];

    for (const [index, { address }] of chain.hubTokens.entries()) {
        const amount = parseUnits(unitsPerToken, decimals[index]!);
        const dealt = await dealToken({ publicClient, testClient, token: address as Address, holder: owner, amount });

        holdings.push({ chainId: chain.id, token: address, amount: dealt ? amount : 0n });
    }

    logger.info("Inventory Funded: ", { chainId: chain.id, holdings: holdings.map((holding) => `${holding.token.slice(0, 8)}=${holding.amount}`) });

    return holdings;
}
