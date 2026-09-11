import { z } from "zod";
import { DelayedError, Queue, Worker, type JobsOptions } from "bullmq";
import { REDIS_URL } from "../lib/config";
import { logger } from "../lib/logger";
import { OrderState, type Order } from "../orders/state-machine";
import type { DepositOutcome, RebalanceOutcome } from "./executor";

const ORDER_QUEUE = "orders";

// one job per order, moving through three stages. the stage is in the payload rather than in the
// queue name so a job can carry itself from one to the next without a second enqueue, and so the
// job id, which is the order id, stays unique for the order's whole life.
const orderJobSchema = z.object({ orderId: z.string().min(1), stage: z.enum(["deposit", "fill", "settle", "rebalance"]) });

type OrderJob = z.infer<typeof orderJobSchema>;

type OrderStages = {
    awaitDeposit(orderId: string): Promise<DepositOutcome>;
    execute(orderId: string): Promise<{ order: Order }>;
    settle(orderId: string): Promise<Order>;
    rebalance(orderId: string): Promise<RebalanceOutcome>;
};

export type FillQueue = ReturnType<typeof createOrderQueue>;

const QUEUE_CONCURRENCY = 4;
// a fill that fails is usually a chain being slow, so it is retried with a widening gap
const QUEUE_ATTEMPTS = 3;
const QUEUE_BACKOFF_MS = 500;
// how often a job asks the chain again while a deposit gathers depth. about a block on the slow
// chains and several on the fast ones; polling faster than blocks arrive learns nothing.
const WAIT_MS = 2_000;

export const defaultJobOptions: JobsOptions = {
    attempts: QUEUE_ATTEMPTS,
    backoff: { type: "exponential", delay: QUEUE_BACKOFF_MS },
    // completed jobs are dropped, which is exactly why the job id cannot be the idempotency guard
    removeOnComplete: true,
    removeOnFail: false,
};

function connection() {
    const url = new URL(REDIS_URL);

    return { host: url.hostname, port: Number(url.port || 6379) };
}

// quoting is synchronous because the caller is waiting on the answer. everything past accept is
// queued, because from there on the order is waiting on chains: for a deposit to land, for a fill
// to be mined, for the deposit to reach finality. none of that should hold a request open.
export function createOrderQueue() {
    const queue = new Queue<OrderJob>(ORDER_QUEUE, { connection: connection() });

    return {
        // the job id is the order id, so a duplicate accept collapses onto the job already queued.
        // that is a first line of defence and not the guard: bullmq only remembers a job id while the
        // record is retained, and once it is dropped the same id can be added again. the order state
        // machine is what actually makes a second fill impossible.
        async enqueue(orderId: string, options: JobsOptions = {}): Promise<string | null> {
            const job = await queue.add(ORDER_QUEUE, { orderId, stage: "deposit" }, { jobId: orderId, ...options });

            return job.id ?? null;
        },

        async pending(): Promise<number> {
            const counts = await queue.getJobCounts("waiting", "active", "delayed", "failed");

            return (counts.waiting ?? 0) + (counts.active ?? 0) + (counts.delayed ?? 0);
        },

        async drain(): Promise<void> {
            await queue.obliterate({ force: true });
        },

        close: () => queue.close(),
    };
}

// retries are safe because every stage is idempotent by order state: a job that runs twice observes
// the state the first run left rather than repeating it.
export function createOrderWorker(stages: OrderStages) {
    const worker = new Worker<OrderJob>(
        ORDER_QUEUE,
        async (job, token) => {
            const { orderId, stage } = orderJobSchema.parse(job.data);

            // the job parks itself and comes back, keeping its id, instead of failing and retrying
            const wait = async (next: OrderJob["stage"]) => {
                await job.updateData({ orderId, stage: next });
                await job.moveToDelayed(Date.now() + WAIT_MS, token);
                throw new DelayedError();
            };

            if (stage === "deposit") {
                // an rpc that does not answer is not a reason to stop watching for a deposit: the
                // deadline bounds the wait, the retry budget is for errors that will not clear
                let status: DepositOutcome["status"];

                try {
                    ({ status } = await stages.awaitDeposit(orderId));
                } catch (error) {
                    logger.warn("Deposit Check Failed: ", {
                        orderId,
                        message: error instanceof Error ? (error.message.split("\n")[0] ?? error.message) : String(error),
                    });

                    return wait("deposit");
                }

                if (status === "waiting") {
                    return wait("deposit");
                }

                if (status !== "confirmed") {
                    return;
                }

                await job.updateData({ orderId, stage: "fill" });
            }

            if (stage === "deposit" || stage === "fill") {
                const { order } = await stages.execute(orderId);

                if (order.state === OrderState.SETTLEMENT_FAILED) {
                    return wait("settle");
                }

                if (order.state !== OrderState.SETTLED) {
                    return;
                }
            }

            if (stage === "settle") {
                const order = await stages.settle(orderId);

                if (order.state === OrderState.SETTLEMENT_FAILED) {
                    return wait("settle");
                }

                if (order.state !== OrderState.SETTLED) {
                    return;
                }
            }

            // a failed rebalance is thrown so the queue's retry policy applies: the order is settled
            // and the user is paid, so this is the one stage where a retry costs nothing but gas
            const rebalanced = await stages.rebalance(orderId);

            if (rebalanced.status === "failed") {
                throw new Error(`Rebalance failed for ${orderId}: ${rebalanced.detail}`);
            }
        },
        { connection: connection(), concurrency: QUEUE_CONCURRENCY, autorun: true },
    );

    worker.on("failed", (job, error) => {
        if (error instanceof DelayedError) {
            return;
        }

        logger.warn("Order Job Failed: ", {
            orderId: job?.data.orderId ?? null,
            stage: job?.data.stage ?? null,
            attempt: job?.attemptsMade ?? 0,
            message: error.message,
        });
    });

    return worker;
}
