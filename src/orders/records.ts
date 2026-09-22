import type Redis from "ioredis";
import type { Fence } from "../lib/leader";

// one hash per collection, one field per record. redis is already the durable boundary here
// because bullmq lives in it: a job that survives a restart has to find its order in the same
// place, or it wakes up to nothing.
export type Records<T> = {
    save(id: string, value: T): Promise<void>;
    loadAll(): Promise<T[]>;
};

// json cannot carry a bigint, and every amount here is one. tagged on the way out, restored on
// the way in, so a record round-trips without the caller knowing which fields are amounts.
const BIGINT_TAG = "$bigint";

function serialize(value: unknown): string {
    return JSON.stringify(value, (_, field: unknown) => (typeof field === "bigint" ? { [BIGINT_TAG]: field.toString() } : field));
}

function deserialize<T>(text: string): T {
    return JSON.parse(text, (_, field: unknown) =>
        field !== null && typeof field === "object" && BIGINT_TAG in field ? BigInt((field as Record<string, string>)[BIGINT_TAG]!) : field,
    ) as T;
}

// a write lands only if the lease still names the writer, checked and written in one step on the
// server. a process that lost the lease without noticing gets an error, not a silent overwrite.
const FENCED_HSET = `
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("hset", KEYS[2], ARGV[2], ARGV[3])
end
return -1`;

export function createRecords<T>(redis: Redis, collection: string, fence: () => Fence): Records<T> {
    const key = `solver:${collection}`;

    return {
        async save(id, value) {
            const lease = fence();
            const written = await redis.eval(FENCED_HSET, 2, lease.key, key, lease.value, id, serialize(value));

            if (written === -1) {
                throw new Error(`Write to ${collection} refused: the lease no longer names this instance`);
            }
        },

        async loadAll() {
            return Object.values(await redis.hgetall(key)).map((text) => deserialize<T>(text));
        },
    };
}
