import type Redis from "ioredis";
import { logger } from "./logger";

type LeaseParams = {
    redis: Redis;
    key: string;
    // how long the lease lasts without a renewal; a holder that stops renewing loses it after this
    ttlMs: number;
    // what this instance calls itself in the lease, so a renewal or release only touches its own
    holder: string;
    // called once the lease is gone and this instance must stop signing
    onLost(): void;
};

// only the holder may renew or release: compare the stored holder before touching the key, in one
// step on the server, so a lease that expired and was taken by another instance is never extended
// or deleted by the old one
const RENEW = `
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("pexpire", KEYS[1], ARGV[2])
end
return 0`;

const RELEASE = `
if redis.call("get", KEYS[1]) == ARGV[1] then
    return redis.call("del", KEYS[1])
end
return 0`;

// one writer at a time. every instance can price, because pricing only reads; only the holder of
// the lease runs the worker, the pollers and the sweepers, which are what send transactions and
// write orders. a second instance waits, and takes over within one ttl of the holder going quiet.
export function createLeaderLease({ redis, key, ttlMs, holder, onLost }: LeaseParams) {
    // renewed three times per ttl, so one missed renewal does not cost the lease
    const renewEveryMs = Math.floor(ttlMs / 3);
    let leading = false;
    let renewer: ReturnType<typeof setInterval> | null = null;

    async function tryAcquire(): Promise<boolean> {
        return (await redis.set(key, holder, "PX", ttlMs, "NX")) === "OK";
    }

    async function renew(): Promise<void> {
        const kept = await redis.eval(RENEW, 1, key, holder, ttlMs);

        if (kept !== 1) {
            leading = false;
            clearInterval(renewer!);
            logger.error("Leader Lease Lost: ", { key, holder });
            onLost();
        }
    }

    async function waitForLeadership(): Promise<void> {
        while (!(await tryAcquire())) {
            await new Promise((resolve) => setTimeout(resolve, renewEveryMs));
        }

        leading = true;
        renewer = setInterval(() => {
            renew().catch((error: unknown) => {
                logger.error("Leader Lease Renewal Failed: ", { key, message: error instanceof Error ? error.message : String(error) });
                leading = false;
                clearInterval(renewer!);
                onLost();
            });
        }, renewEveryMs);
        logger.info("Leader Lease Acquired: ", { key, holder, ttlMs });
    }

    async function release(): Promise<void> {
        if (renewer !== null) {
            clearInterval(renewer);
        }

        if (leading) {
            leading = false;
            await redis.eval(RELEASE, 1, key, holder);
        }
    }

    return { waitForLeadership, release, isLeader: () => leading };
}
