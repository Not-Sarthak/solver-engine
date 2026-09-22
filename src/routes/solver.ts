import { timingSafeEqual } from "node:crypto";
import { isAddress, zeroAddress } from "viem";
import { chainRegistry } from "../chain/chain-registry";
import { z } from "zod";
import rateLimit from "@fastify/rate-limit";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { type Intent } from "../orders/intents";
import { publicStatusOf, type Order } from "../orders/state-machine";
import { type PricedQuote } from "../quoting/pricing";
import { defaultJobOptions, type FillQueue } from "../execution/fill-queue";
import { type createSolver } from "../solver";

const baseUnitsSchema = z.string().regex(/^\d+$/, "must be an integer in base units");

// an address is only an address for its chain: 20 hex bytes on an evm chain, a base58 key on
// solana. a recipient that fails this is a payout to nowhere, so it is refused before pricing.
// the zero address is refused too: a transfer to it is a burn, not a payment.
function fitsChain(chainId: number, value: string): boolean {
    if (!chainRegistry.has(chainId)) {
        return true;
    }

    return chainRegistry.get(chainId).vmType === "evm"
        ? isAddress(value, { strict: false }) && value.toLowerCase() !== zeroAddress
        : /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
}

const intentBodySchema = z
    .object({
        originChainId: z.int().positive(),
        originToken: z.string().min(1),
        amount: baseUnitsSchema,
        destinationChainId: z.int().positive(),
        destinationToken: z.string().min(1),
        recipient: z.string().min(1),
        refundTo: z.string().min(1).optional(),
        minAmountOut: baseUnitsSchema,
        ttlSeconds: z.int().positive(),
    })
    .superRefine((body, context) => {
        for (const [path, chainId, value] of [
            ["originToken", body.originChainId, body.originToken],
            ["destinationToken", body.destinationChainId, body.destinationToken],
            ["recipient", body.destinationChainId, body.recipient],
            ["refundTo", body.originChainId, body.refundTo],
        ] as const) {
            if (value !== undefined && !fitsChain(chainId, value)) {
                context.addIssue({ code: "custom", path: [path], message: `not an address on chain ${chainId}` });
            }
        }
    });

const feesSchema = z.object({
    relayerGas: z.string(),
    relayerService: z.string(),
    app: z.string(),
    settlement: z.string(),
    rebalance: z.string(),
    riskBuffer: z.string(),
});

const routeSchema = z.object({
    hops: z.number(),
    grossAmountOut: z.string(),
    gasUsed: z.string(),
    gasCostInOutputToken: z.string(),
    legs: z.array(
        z.object({
            sourceId: z.string(),
            poolId: z.string(),
            tokenIn: z.string(),
            tokenOut: z.string(),
            amountOut: z.string(),
            latencyMs: z.number(),
        }),
    ),
});

const orderSchema = z.object({
    orderId: z.string(),
    intentId: z.string(),
    status: z.string(),
    state: z.string(),
    failReason: z.string().nullable(),
    failDetail: z.string().nullable(),
    quoteId: z.string().nullable(),
    depositTx: z.string().nullable(),
    fillTx: z.string().nullable(),
    refundTx: z.string().nullable(),
    history: z.array(z.object({ from: z.string(), to: z.string(), atMs: z.number(), reason: z.string().nullable() })),
});

// every amount crosses the wire as a base-unit string. json numbers cannot hold 18-decimal wei,
// which is the same reason the domain uses bigint, and relay's api does exactly this.
function presentFees(priced: PricedQuote) {
    return {
        relayerGas: priced.fees.relayerGas.toString(),
        relayerService: priced.fees.relayerService.toString(),
        app: priced.fees.app.toString(),
        settlement: priced.fees.settlement.toString(),
        rebalance: priced.fees.rebalance.toString(),
        riskBuffer: priced.fees.riskBuffer.toString(),
    };
}

function presentRoute(priced: PricedQuote) {
    return {
        hops: priced.path.legs.length,
        grossAmountOut: priced.path.amountOut.toString(),
        gasUsed: priced.path.gasUsed.toString(),
        gasCostInOutputToken: priced.path.gasCostInOutputToken.toString(),
        legs: priced.path.legs.map((leg) => ({
            sourceId: leg.quote.sourceId,
            poolId: leg.quote.poolId,
            tokenIn: leg.tokenIn,
            tokenOut: leg.tokenOut,
            amountOut: leg.quote.amountOut.toString(),
            latencyMs: leg.quote.latencyMs,
        })),
    };
}

function presentOrder(order: Order) {
    return {
        orderId: order.id,
        intentId: order.intentId,
        status: publicStatusOf(order.state),
        state: order.state,
        failReason: order.failureReason,
        failDetail: order.failureDetail,
        quoteId: order.quoteId,
        depositTx: order.deposit?.txHash ?? null,
        fillTx: order.fillTx,
        refundTx: order.refundTx,
        history: order.history.map((step) => ({ from: step.from, to: step.to, atMs: step.atMs, reason: step.reason })),
    };
}

type RouteAccess = { adminApiKey: string; quotesPerMinute: number; isLeader(): boolean };

// what @fastify/rate-limit answers with, declared so the serializer knows the shape
const throttledSchema = z.object({ statusCode: z.number(), error: z.string(), message: z.string() });

export function createSolverRoutes(
    solver: ReturnType<typeof createSolver>,
    now: () => number,
    fills: FillQueue,
    access: RouteAccess,
): FastifyPluginAsyncZod {
    function toIntent(body: z.infer<typeof intentBodySchema>): Intent {
        return {
            id: crypto.randomUUID(),
            origin: { chainId: body.originChainId, token: body.originToken, amount: BigInt(body.amount) },
            destination: { chainId: body.destinationChainId, token: body.destinationToken, recipient: body.recipient },
            refundTo: body.refundTo ?? null,
            minAmountOut: BigInt(body.minAmountOut),
            deadlineMs: now() + body.ttlSeconds * 1000,
        };
    }

    // the routes that show everything are for the operator. the key travels in a header, compared
    // in constant time, and a wrong one gets the same answer as a missing one.
    const adminOnly = async (request: FastifyRequest, reply: FastifyReply) => {
        const presented = request.headers["x-api-key"];
        const key = typeof presented === "string" ? presented : "";
        const ok = key.length === access.adminApiKey.length && timingSafeEqual(Buffer.from(key), Buffer.from(access.adminApiKey));

        if (!ok) {
            await reply.status(401).send({ failReason: "UNAUTHORIZED" });

            return reply;
        }
    };

    // pricing does real work per call, so it is metered per client
    const metered = { rateLimit: { max: access.quotesPerMinute, timeWindow: "1 minute" } };

    // a quote is a promise and an accept is an order: both are writes, and only the instance
    // holding the writer lease makes them. any instance can price.
    const leaderOnly = async (_request: FastifyRequest, reply: FastifyReply) => {
        if (!access.isLeader()) {
            await reply.status(503).send({ failReason: "NOT_LEADER" });

            return reply;
        }
    };

    return async (app) => {
        await app.register(rateLimit, { global: false });

        app.post(
            "/price",
            {
                config: metered,
                schema: {
                    summary: "Indicative price, reserves nothing and issues no quote",
                    tags: ["solver"],
                    body: intentBodySchema,
                    response: {
                        200: z.object({ amountOut: z.string(), expectedProfit: z.string(), fees: feesSchema, route: routeSchema }),
                        422: z.object({ failReason: z.string() }),
                        429: throttledSchema,
                    },
                },
            },
            async (request, reply) => {
                const priced = await solver.priceIntent(toIntent(request.body));

                if (!priced.ok) {
                    return reply.status(422).send({ failReason: priced.reason });
                }

                return {
                    amountOut: priced.priced.quotedAmountOut.toString(),
                    expectedProfit: priced.priced.expectedProfit.toString(),
                    fees: presentFees(priced.priced),
                    route: presentRoute(priced.priced),
                };
            },
        );

        app.post(
            "/quote",
            {
                config: metered,
                preHandler: leaderOnly,
                schema: {
                    summary: "Executable quote with a ttl, and the order it belongs to",
                    tags: ["solver"],
                    body: intentBodySchema,
                    response: {
                        200: z.object({
                            orderId: z.string(),
                            intentId: z.string(),
                            quote: z.object({
                                quoteId: z.string(),
                                amountOut: z.string(),
                                expectedProfit: z.string(),
                                expiresAtMs: z.number(),
                                fees: feesSchema,
                                route: routeSchema,
                            }),
                        }),
                        422: z.object({ failReason: z.string() }),
                        429: throttledSchema,
                        503: z.object({ failReason: z.string() }),
                    },
                },
            },
            async (request, reply) => {
                const intent = toIntent(request.body);
                const quoted = await solver.quoteIntent(intent);

                if (!quoted.ok) {
                    return reply.status(422).send({ failReason: quoted.reason });
                }

                const { quote } = quoted;

                return {
                    orderId: quoted.order.id,
                    intentId: intent.id,
                    quote: {
                        quoteId: quote.id,
                        amountOut: quote.quotedAmountOut.toString(),
                        expectedProfit: quote.expectedProfit.toString(),
                        expiresAtMs: quote.expiresAtMs,
                        fees: presentFees(quote),
                        route: presentRoute(quote),
                    },
                };
            },
        );

        // accepting commits the quote and tells the user where to send the deposit. from here the
        // order is the queue's: it watches for the transfer, fills once it has depth, and settles
        // once it is final. none of that holds a connection open; the caller follows the order on
        // GET /orders/:orderId.
        app.post(
            "/orders/:orderId/accept",
            {
                preHandler: leaderOnly,
                schema: {
                    summary: "Accept a quote, get the deposit instructions, and queue the order",
                    tags: ["solver"],
                    params: z.object({ orderId: z.string().min(1) }),
                    response: {
                        202: z.object({
                            order: orderSchema,
                            deposit: z.object({ chainId: z.number(), token: z.string(), amount: z.string(), to: z.string() }),
                            jobId: z.string().nullable(),
                        }),
                        409: z.object({ failReason: z.string() }),
                        503: z.object({ failReason: z.string() }),
                    },
                },
            },
            async (request, reply) => {
                const accepted = await solver.acceptOrder(request.params.orderId);

                if (!accepted.ok) {
                    return reply.status(409).send({ failReason: accepted.reason });
                }

                const wanted = accepted.order.depositWanted!;
                const jobId = await fills.enqueue(request.params.orderId, defaultJobOptions);

                return reply.status(202).send({
                    order: presentOrder(accepted.order),
                    deposit: { chainId: wanted.chainId, token: wanted.token, amount: wanted.amount.toString(), to: wanted.to },
                    jobId,
                });
            },
        );

        app.get(
            "/orders/:orderId",
            {
                schema: {
                    summary: "Order status, mirroring the vocabulary of /intents/status/v3",
                    tags: ["solver"],
                    params: z.object({ orderId: z.string().min(1) }),
                    response: { 200: orderSchema, 404: z.object({ failReason: z.string() }) },
                },
            },
            async (request, reply) => {
                const order = solver.orders.get(request.params.orderId);

                return order === null ? reply.status(404).send({ failReason: "QUOTE_NOT_FOUND" }) : presentOrder(order);
            },
        );

        app.get(
            "/orders",
            {
                preHandler: adminOnly,
                schema: {
                    summary: "All orders (admin)",
                    tags: ["solver"],
                    response: { 200: z.array(orderSchema), 401: z.object({ failReason: z.string() }) },
                },
            },
            async () => solver.orders.all().map(presentOrder),
        );

        app.get(
            "/swap-sources",
            {
                schema: {
                    summary: "Every venue the solver can quote against, per chain",
                    tags: ["solver"],
                    response: {
                        200: z.object({
                            chains: z.array(
                                z.object({
                                    chainId: z.number(),
                                    name: z.string(),
                                    vmType: z.string(),
                                    // an evm chain lists its amm deployments; a chain reached through routers lists those
                                    sources: z.array(z.string()),
                                    // whether the solver can pay out here, or only value a deposit
                                    fillable: z.boolean(),
                                }),
                            ),
                        }),
                    },
                },
            },
            async () => ({
                chains: [...solver.environments.values()].map((environment) => ({
                    chainId: environment.chain.id,
                    name: environment.chain.name,
                    vmType: environment.chain.vmType,
                    sources:
                        environment.chain.vmType === "evm"
                            ? environment.chain.amms.map((amm) => amm.id)
                            : environment.sources.list().map((source) => source.id),
                    fillable: solver.fillable.has(environment.chain.id),
                })),
            }),
        );

        app.get(
            "/inventory",
            {
                preHandler: adminOnly,
                schema: {
                    summary: "Solver balances per chain and token (admin)",
                    tags: ["solver"],
                    response: {
                        200: z.record(z.string(), z.object({ available: z.string(), reserved: z.string() })),
                        401: z.object({ failReason: z.string() }),
                    },
                },
            },
            async () =>
                Object.fromEntries(
                    Object.entries(solver.inventory.snapshot()).map(([key, balance]) => [
                        key,
                        { available: balance.available.toString(), reserved: balance.reserved.toString() },
                    ]),
                ),
        );
    };
}
