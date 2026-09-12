import { createWalletClient, defineChain, http } from "viem";
import type { Address, PublicClient, TestClient, WalletClient } from "viem";
import { privateKeyToAccount, type LocalAccount } from "viem/accounts";
import { erc20Abi } from "./abis";
import { chainRegistry, rpcUrlFor } from "./chain-registry";
import { createChainClient, RPC_TIMEOUT_MS } from "./client";
import { startFork, type Fork } from "./fork";
import { fundInventory, type Holding } from "./funding";
import { logger } from "../lib/logger";

export type ChainRuntime = {
    chainId: number;
    // null for a chain reached only through quote apis, which need no rpc client of their own
    client: PublicClient | null;
    blockNumber: bigint;
    // null where the solver cannot sign: an origin it can value but never pay out on. testClient is
    // null on a live chain, which is what tells the fill engine it cannot snapshot or write storage.
    fill: { publicClient: PublicClient; walletClient: WalletClient; testClient: TestClient | null; signer: LocalAccount } | null;
};

type ExecutionMode = "fork" | "live";

type ChainRuntimesParams = { chainIds: readonly number[]; basePort: number; mode: ExecutionMode; privateKey: `0x${string}` };

// the fork account's ether and per-token inventory. harness constants: large enough that no fill in
// a session runs the solver dry, and written straight into storage so the pools are not moved.
const FORK_FUND_ETHER = "10000";

const FORK_UNITS_PER_TOKEN = "1000000";

// a chain the solver can read is a chain it can quote a deposit on. a chain it can also sign on is a
// chain it can pay out on. the two are separate capabilities because a cross-chain fill only ever
// signs on the destination, so an origin chain needs no wallet and no inventory.
//
// on a fork every served chain gets its own anvil, pinned to the block its quotes are read at, and
// inventory is written into storage. live, the same signer connects to the real rpc, inventory is
// whatever the account actually holds, and nothing is forked or written.
export async function startChainRuntimes({ chainIds, basePort, mode, privateKey }: ChainRuntimesParams): Promise<{
    runtimes: ChainRuntime[];
    holdings: Holding[];
    signer: Address;
    stop: () => void;
}> {
    const signer = privateKeyToAccount(privateKey);
    const runtimes: ChainRuntime[] = [];
    const holdings: Holding[] = [];
    const forks: Fork[] = [];

    for (const [index, chainId] of chainIds.entries()) {
        const chain = chainRegistry.get(chainId);

        // an svm chain is quotable through its routers and nothing else: no signer, no inventory.
        // it starts nothing and can only ever be the origin of a cross-chain intent.
        if (chain.vmType === "svm") {
            runtimes.push({ chainId, client: null, blockNumber: 1n, fill: null });
            continue;
        }

        const client = createChainClient(chain);
        const blockNumber = await client.getBlockNumber();

        if (mode === "fork") {
            const fork = await startFork({ chain, port: basePort + index, fundEther: FORK_FUND_ETHER, forkBlock: blockNumber, account: signer });

            forks.push(fork);
            holdings.push(
                ...(await fundInventory({
                    chain,
                    publicClient: fork.publicClient,
                    testClient: fork.testClient,
                    account: fork.account,
                    unitsPerToken: FORK_UNITS_PER_TOKEN,
                })),
            );
            runtimes.push({
                chainId,
                client,
                blockNumber,
                fill: { publicClient: fork.publicClient, walletClient: fork.walletClient, testClient: fork.testClient, signer },
            });
            continue;
        }

        const viemChain = defineChain({
            id: chain.id,
            name: chain.name,
            nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
            rpcUrls: { default: { http: [rpcUrlFor(chain)] } },
        });
        const walletClient = createWalletClient({
            account: signer,
            chain: viemChain,
            transport: http(rpcUrlFor(chain), { timeout: RPC_TIMEOUT_MS }),
        });
        const balances = await client.multicall({
            contracts: chain.hubTokens.map(({ address }) => ({
                address: address as Address,
                abi: erc20Abi,
                functionName: "balanceOf" as const,
                args: [signer.address] as const,
            })),
            allowFailure: false,
        });

        holdings.push(...chain.hubTokens.map(({ address }, position) => ({ chainId, token: address, amount: balances[position]! })));
        runtimes.push({ chainId, client, blockNumber, fill: { publicClient: client, walletClient, testClient: null, signer } });

        logger.info("Live Chain Ready: ", {
            chain: chain.name,
            chainId,
            account: signer.address,
            holdings: chain.hubTokens.map(({ address }, position) => `${address.slice(0, 8)}=${balances[position]}`),
        });
    }

    return { runtimes, holdings, signer: signer.address, stop: () => forks.forEach((fork) => fork.stop()) };
}
