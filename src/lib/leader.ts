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

// what a writer presents to prove it still leads: the lease key and the value this instance
// holds it under, which carries the acquisition number
export type Fence = { key: string; value: string };

// one writer at a time. every instance can price, because pricing only reads; only the holder of
// the lease runs the worker, the pollers and the sweepers, which are what send transactions and
// write orders. a second instance waits, and takes over within one ttl of the holder going quiet.
//
// the lease alone is not enough: a holder that stalls (a long gc pause, a blocked event loop) can
// wake up after its lease expired and another instance took over, and carry on as if it still
// led. so every acquisition takes a number from a counter that only goes up, the number is part
// of the lease value, and every write checks the lease still holds this instance's number before
// it goes out: a transaction is sent only after the check, and a record write is refused by redis
// itself when the number has moved on. a stalled holder's writes fail instead of racing the new one.
export function createLeaderLease({ redis, key, ttlMs, holder, onLost }: LeaseParams) {
    // renewed three times per ttl, so one missed renewal does not cost the lease
    const renewEveryMs = Math.floor(ttlMs / 3);
    let leading = false;
    let value: string | null = null;
    let renewer: ReturnType<typeof setInterval> | null = null;

    async function tryAcquire(): Promise<boolean> {
        const token = await redis.incr(`${key}:epoch`);
        const candidate = `${holder}#${token}`;

        if ((await redis.set(key, candidate, "PX", ttlMs, "NX")) !== "OK") {
            return false;
        }

        value = candidate;

        return true;
    }

    async function renew(): Promise<void> {
        const kept = await redis.eval(RENEW, 1, key, value!, ttlMs);

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
        logger.info("Leader Lease Acquired: ", { key, holder, token: value, ttlMs });
    }

    async function release(): Promise<void> {
        if (renewer !== null) {
            clearInterval(renewer);
        }

        if (leading) {
            leading = false;
            await redis.eval(RELEASE, 1, key, value!);
        }
    }

    function fence(): Fence {
        if (!leading || value === null) {
            throw new Error("Not the leader");
        }

        return { key, value };
    }

    // the check a transaction makes just before it is sent: the lease, as redis sees it now, still
    // carries this instance's number. a stalled holder learns here that the world moved on.
    async function assertLeading(): Promise<void> {
        const { key: leaseKey, value: mine } = fence();

        if ((await redis.get(leaseKey)) !== mine) {
            leading = false;
            logger.error("Leader Fence Failed: ", { key, holder, token: mine });
            onLost();
            throw new Error("Leadership lost before send");
        }
    }

    return { waitForLeadership, release, fence, assertLeading, isLeader: () => leading };
}
