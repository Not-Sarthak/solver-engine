import type Redis from "ioredis";

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

export function createRecords<T>(redis: Redis, collection: string): Records<T> {
    const key = `solver:${collection}`;

    return {
        async save(id, value) {
            await redis.hset(key, id, serialize(value));
        },

        async loadAll() {
            return Object.values(await redis.hgetall(key)).map((text) => deserialize<T>(text));
        },
    };
}
