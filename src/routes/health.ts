import { z } from "zod";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";

const health: FastifyPluginAsyncZod = async (app) => {
    app.get(
        "/health",
        {
            schema: {
                summary: "Health Check",
                tags: ["system"],
                response: { 200: z.object({ status: z.literal("ok") }) },
            },
        },
        async () => ({ status: "ok" as const }),
    );
};

export default health;
