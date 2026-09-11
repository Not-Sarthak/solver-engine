import { createPublicClient, defineChain, http, type PublicClient } from "viem";
import { rpcUrlFor, type ChainConfig } from "./chain-registry";

// a tick load against a public endpoint can take most of a minute; the budget is per request, not per pool
export const RPC_TIMEOUT_MS = 120_000;

// a throttled answer (429, or the node's own limit-exceeded code) is retried at the transport, so
// every call gets it and not only the multicall path. viem's default is three tries from 150ms,
// which is over in a second; a public endpoint that has started refusing needs tens of seconds.
// six tries doubling from 500ms wait up to about 31s in total before the error is raised.
const RPC_RETRY_COUNT = 6;
const RPC_RETRY_DELAY_MS = 500;

// the widest eth_getLogs range the public endpoints in the registry accept: blastapi answers a
// wider one with "You can make eth_getLogs requests with up to a 10 block range". an anvil fork
// proxies the part of a range before its fork block upstream, so it has the same limit there.
const LOG_RANGE_BLOCKS = 10n;

// deployed at the same address on every chain we support, verified on chain. without it a single
// v3 pool needs one eth_call per initialised tick, which public rpcs will not serve.
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

// no transport-level json-rpc batching: chunkedMulticall already bounds each request, and http
// batching recombines those chunks into one oversized body that public rpcs answer with a 503.
type GetLogsParams = Parameters<PublicClient["getLogs"]>[0] & { fromBlock: bigint; toBlock: bigint };

// one logical range, as many requests as the endpoint allows, in order
export async function getLogsInRanges<T>(client: PublicClient, params: GetLogsParams): Promise<T[]> {
    const logs: T[] = [];

    for (let start = params.fromBlock; start <= params.toBlock; start += LOG_RANGE_BLOCKS) {
        const end = start + LOG_RANGE_BLOCKS - 1n < params.toBlock ? start + LOG_RANGE_BLOCKS - 1n : params.toBlock;

        logs.push(...((await client.getLogs({ ...params, fromBlock: start, toBlock: end })) as T[]));
    }

    return logs;
}

export function createChainClient(chain: ChainConfig): PublicClient {
    const viemChain = defineChain({
        id: chain.id,
        name: chain.name,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrlFor(chain)] } },
        contracts: { multicall3: { address: MULTICALL3_ADDRESS } },
    });

    return createPublicClient({
        chain: viemChain,
        transport: http(rpcUrlFor(chain), { timeout: RPC_TIMEOUT_MS, retryCount: RPC_RETRY_COUNT, retryDelay: RPC_RETRY_DELAY_MS }),
        batch: { multicall: true },
    }) as PublicClient;
}
