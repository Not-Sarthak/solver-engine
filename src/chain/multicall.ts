import { type PublicClient } from "viem";
import { logger } from "../lib/logger";

type Contract = Parameters<PublicClient["multicall"]>[0]["contracts"][number];

// measured against publicnode: chunks of 400 run at 1.39ms per call and 800 still succeeds; 40 cost
// 4.70ms per call. a small concurrency cap keeps a burst of tick reads inside a public rate limit.
const MULTICALL_CHUNK_SIZE = 400;

const MULTICALL_CONCURRENT_CHUNKS = 4;

// public endpoints answer a burst with a rate limit. retries back off exponentially from this base,
// and the call still fails loudly once they are exhausted.
const MULTICALL_RETRY_ATTEMPTS = 6;

const MULTICALL_RETRY_BASE_MS = 500;

// public rpcs reject a multicall carrying hundreds of tick reads: the calldata alone is tens of
// kilobytes. chunking keeps each request small, and a small concurrency cap keeps us inside their
// rate limits. a paid endpoint would take far larger batches, which is a cost decision, not a code one.

export async function chunkedMulticall<T>(client: PublicClient, contracts: readonly Contract[], blockNumber: bigint): Promise<T[]> {
    const chunks: (readonly Contract[])[] = [];

    for (let start = 0; start < contracts.length; start += MULTICALL_CHUNK_SIZE) {
        chunks.push(contracts.slice(start, start + MULTICALL_CHUNK_SIZE));
    }

    const results: T[] = [];

    // rate limiting is a normal answer from a public endpoint, not an error to give up on: a pool
    // with full tick coverage is well over a thousand calls, and a cross-chain quote asks two chains
    // for that at once. the wait doubles each time so a throttled endpoint is given room to recover,
    // and the failure is still raised once the attempts run out rather than returning short results,
    // which would look like a pool with no ticks and quote a wrong number.
    for (let start = 0; start < chunks.length; start += MULTICALL_CONCURRENT_CHUNKS) {
        const batch = chunks.slice(start, start + MULTICALL_CONCURRENT_CHUNKS);
        const settled = await Promise.all(
            batch.map(async (chunk): Promise<T[]> => {
                let wait = MULTICALL_RETRY_BASE_MS;

                for (let attempt = 1; ; attempt++) {
                    try {
                        return (await client.multicall({ contracts: [...chunk], allowFailure: false, blockNumber })) as T[];
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        const throttled = /rate limit|429|too many requests/i.test(message);

                        if (!throttled || attempt >= MULTICALL_RETRY_ATTEMPTS) {
                            throw error;
                        }

                        logger.warn("Rpc Throttled: ", { attempt, waitMs: wait, calls: chunk.length });
                        await new Promise((resolve) => setTimeout(resolve, wait));
                        wait *= 2;
                    }
                }
            }),
        );

        results.push(...settled.flat());
    }

    return results;
}
