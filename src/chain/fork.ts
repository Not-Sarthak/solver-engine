import { RPC_TIMEOUT_MS } from "./client";
import { createPublicClient, createTestClient, createWalletClient, defineChain, http, parseEther } from "viem";
import type { Address, PublicClient, TestClient, WalletClient } from "viem";
import type { PrivateKeyAccount } from "viem/accounts";
import { logger } from "../lib/logger";
import { rpcUrlFor, type ChainConfig } from "./chain-registry";

export type Fork = {
    publicClient: PublicClient;
    walletClient: WalletClient;
    testClient: TestClient;
    account: Address;
    forkedAtBlock: bigint;
    stop: () => void;
};

type ForkParams = { chain: ChainConfig; port: number; fundEther: string; forkBlock: bigint; account: PrivateKeyAccount };

// forking through a public endpoint took 12 to 30 seconds; 15 was too tight and cost a fork
const FORK_READY_TIMEOUT_MS = 90_000;

const FORK_POLL_INTERVAL_MS = 100;

const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

export async function startFork({ chain, port, fundEther, forkBlock, account }: ForkParams): Promise<Fork> {
    const url = `http://127.0.0.1:${port}`;
    const forkChain = defineChain({
        id: chain.id,
        name: `${chain.name}-fork`,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [url] } },
        contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
    });

    // attaching to whatever already answers on this port would silently quote against a different
    // block than the one we asked for, so an occupied port is an error rather than a shortcut.
    const occupant = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId" }),
    }).catch(() => null);

    if (occupant !== null) {
        throw new Error(`Port ${port} is already serving json-rpc; stop it before starting a fork`);
    }

    const anvil = Bun.spawn(
        [
            "anvil",
            "--fork-url",
            rpcUrlFor(chain),
            "--fork-block-number",
            String(forkBlock),
            "--port",
            String(port),
            "--silent",
            "--chain-id",
            String(chain.id),
        ],
        { stdout: "ignore", stderr: "ignore" },
    );

    const publicClient = createPublicClient({
        chain: forkChain,
        transport: http(url, { batch: true, timeout: RPC_TIMEOUT_MS }),
        batch: { multicall: true },
    }) as PublicClient;
    const walletClient = createWalletClient({ account, chain: forkChain, transport: http(url, { timeout: RPC_TIMEOUT_MS }) });
    const testClient = createTestClient({ chain: forkChain, mode: "anvil", transport: http(url, { timeout: RPC_TIMEOUT_MS }) });

    const attempts = Math.ceil(FORK_READY_TIMEOUT_MS / FORK_POLL_INTERVAL_MS);
    let forkedAtBlock = 0n;

    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            forkedAtBlock = await publicClient.getBlockNumber();
            break;
        } catch {
            await Bun.sleep(FORK_POLL_INTERVAL_MS);
        }
    }

    if (forkedAtBlock === 0n) {
        anvil.kill();
        throw new Error(`Fork of ${chain.name} did not start on ${url} within ${FORK_READY_TIMEOUT_MS}ms`);
    }

    if (forkedAtBlock !== forkBlock) {
        anvil.kill();
        throw new Error(`Fork reports block ${forkedAtBlock} but was asked for ${forkBlock}`);
    }

    await testClient.setBalance({ address: account.address, value: parseEther(fundEther) });

    logger.info("Fork Started: ", {
        chain: chain.name,
        chainId: chain.id,
        port,
        forkedAtBlock: forkedAtBlock.toString(),
        account: account.address,
        fundEther,
    });

    return { publicClient, walletClient, testClient: testClient as TestClient, account: account.address, forkedAtBlock, stop: () => anvil.kill() };
}
