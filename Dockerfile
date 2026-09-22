FROM oven/bun:1.3

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl -L https://foundry.paradigm.xyz | bash \
    && /root/.foundry/bin/foundryup
ENV PATH="/root/.foundry/bin:${PATH}"

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY src ./src
COPY tsconfig.json ./

EXPOSE 4000

HEALTHCHECK --interval=15s --timeout=5s --start-period=180s --retries=3 \
    CMD curl -fsS http://127.0.0.1:4000/health || exit 1

CMD ["bun", "run", "src/index.ts"]
