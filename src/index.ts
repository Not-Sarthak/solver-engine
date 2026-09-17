import Fastify, { type FastifyError } from "fastify";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { serializerCompiler, validatorCompiler, jsonSchemaTransform, hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import {
    APP_BPS,
    EXECUTION_MODE,
    FORK_PORT,
    PORT,
    QUOTE_TTL_MS,
    DEPOSIT_WINDOW_MS,
    RISK_HORIZON_MS,
    RISK_BPS,
    GAS_CACHE_TTL_MS,
    SERVICE_BPS,
    REDIS_URL,
    ADMIN_API_KEY,
    QUOTE_RATE_LIMIT_PER_MINUTE,
    SOLVER_CHAIN_IDS,
    SOLVER_PRIVATE_KEY,
    SWEEP_IGNORE_FROM,
    SWEEP_MAX_ATTEMPTS,
    SWEEP_STRAYS,
} from "./lib/config";
import { logger } from "./lib/logger";
import { chainRegistry } from "./chain/chain-registry";
import { startChainRuntimes } from "./chain/runtime";
import Redis from "ioredis";
import type { Address } from "viem";
import { createOrderQueue, createOrderWorker } from "./execution/fill-queue";
import { createRecords } from "./orders/records";
import { createSolverRoutes } from "./routes/solver";
import health from "./routes/health";
import { createSolver } from "./solver";

async function buildApp() {
    // fastify's own pino logger is off; winston is the single log sink so stdout stays one json format
    const app = Fastify({ logger: false });

    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(swagger, {
        openapi: { info: { title: "Solver Engine", version: "0.0.0" } },
        transform: jsonSchemaTransform,
    });
    await app.register(swaggerUi, { routePrefix: "/docs" });

    app.addHook("onResponse", async (request, reply) => {
        const line = { method: request.method, path: request.url, status: reply.statusCode, durationMs: Number(reply.elapsedTime.toFixed(3)) };

        if (reply.statusCode >= 500) {
            logger.error("request", line);
        } else if (reply.statusCode >= 400) {
            logger.warn("request", line);
        } else {
            logger.info("request", line);
        }
    });

    app.setErrorHandler((error: FastifyError, request, reply) => {
        if (hasZodFastifySchemaValidationErrors(error)) {
            logger.warn("Request Validation Failed: ", { path: request.url, method: request.method, issues: error.validation.length });

            return reply.status(400).send({ error: "Invalid Request" });
        }

        const status = error.statusCode ?? 500;

        if (status < 500) {
            logger.warn("Handled HTTP Error: ", { status, error: error.message, path: request.url, method: request.method });

            return reply.status(status).send({ error: error.message });
        }

        // winston serializes an Error in meta to {}, so the fields are pulled out by hand.
        logger.error("Unhandled Server Error: ", { path: request.url, method: request.method, error: error.message, stack: error.stack });

        return reply.status(500).send({ error: "Internal Server Error" });
    });

    app.setNotFoundHandler((_request, reply) => reply.status(404).send({ error: "Not Found" }));

    await app.register(health);

    return app;
}

async function buildServer() {
    const app = await buildApp();

    const now = () => Date.now();
    const redis = new Redis(REDIS_URL);

    // fills execute against a fork of each served chain: real routers, real gas, real reverts,
    // without spending real money.
    const { runtimes, holdings, signer, stop } = await startChainRuntimes({
        chainIds: SOLVER_CHAIN_IDS,
        basePort: FORK_PORT,
        mode: EXECUTION_MODE,
        privateKey: SOLVER_PRIVATE_KEY as `0x${string}`,
    });

    const solver = createSolver({
        chains: runtimes,
        holdings,
        depositAddress: signer,
        ttlMs: QUOTE_TTL_MS,
        depositWindowMs: DEPOSIT_WINDOW_MS,
        riskHorizonMs: RISK_HORIZON_MS,
        riskBps: RISK_BPS,
        gasCacheTtlMs: GAS_CACHE_TTL_MS,
        serviceBps: SERVICE_BPS,
        appBps: APP_BPS,
        records: {
            orders: createRecords(redis, "orders"),
            intents: createRecords(redis, "intents"),
            quotes: createRecords(redis, "quotes"),
            strays: createRecords(redis, "strays"),
            sweepCursors: createRecords(redis, "sweep-cursors"),
            balances: createRecords(redis, "balances"),
            reservations: createRecords(redis, "reservations"),
        },
        sweep: { enabled: SWEEP_STRAYS, ignoreFrom: SWEEP_IGNORE_FROM as Address[], maxAttempts: SWEEP_MAX_ATTEMPTS },
        now,
    });

    await solver.restore();

    const fills = createOrderQueue();
    // the worker runs in this process because there is one solver. splitting it out is a deployment
    // decision, not a code one: the queue is already the boundary.
    const worker = createOrderWorker({
        awaitDeposit: (orderId) => solver.awaitDeposit(orderId),
        execute: (orderId) => solver.executeOrder(orderId),
        settle: (orderId) => solver.settleOrder(orderId),
        refund: (orderId) => solver.refundOrder(orderId),
        rebalance: (orderId) => solver.rebalanceOrder(orderId),
    });

    // every evm chain is polled at its own block interval, and each new block replays the loaded
    // pools' events so the next quote reads the state that exists, not the state at boot. a poll
    // that fails is logged and the next one runs; the solver keeps quoting from the last good block.
    const pollers = runtimes
        .filter((runtime) => runtime.client !== null)
        .map((runtime) => {
            const chain = chainRegistry.get(runtime.chainId);
            const interval = setInterval(
                () => {
                    solver.sync(runtime.chainId).catch((error: unknown) => {
                        logger.warn("Pool Sync Failed: ", {
                            chainId: runtime.chainId,
                            message: error instanceof Error ? error.message : String(error),
                        });
                    });
                    solver.sweepStrays(runtime.chainId).catch((error: unknown) => {
                        logger.warn("Sweep Failed: ", {
                            chainId: runtime.chainId,
                            message: error instanceof Error ? error.message : String(error),
                        });
                    });
                },
                chain.vmType === "evm" ? chain.blockTimeMs : 0,
            );

            return interval;
        });

    await app.register(createSolverRoutes(solver, now, fills, { adminApiKey: ADMIN_API_KEY, quotesPerMinute: QUOTE_RATE_LIMIT_PER_MINUTE }));

    app.addHook("onClose", async () => {
        pollers.forEach((interval) => clearInterval(interval));
        await worker.close();
        await fills.close();
        redis.disconnect();
        stop();
    });

    return app;
}

if (import.meta.main) {
    const app = await buildServer();
    await app.listen({ port: PORT });
    logger.info("Server Started: ", { port: PORT });
}
