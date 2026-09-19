# Solver Engine

A cross-chain fill-then-settle solver. Given an intent such as selling 1 WETH on Arbitrum for USDC
on Base, it prices the trade against real pool state on both chains, waits for the user's deposit,
pays the user with a signed transaction, and settles once the deposit is final.

- Pool addresses are derived with CREATE2 and read from mainnet, never from a subgraph or a list.
- Output amounts come from our own Uniswap V2 and V3 implementations, which match QuoterV2 to the wei.
- Gas is a transaction receipt on a fork or `estimateGas` on the live chain, never an estimate of our own.
- Fills, refunds and rebalances are signed transactions, on anvil forks of the chains or on the chains themselves.

## What a solver is

A solver is a market maker that buys a user's deposit at a discount. The user sends 10,000 USDC on
Base, the solver pays them ETH on Arbitrum out of its own inventory, and collects the 10,000 USDC
afterwards. The spread is its revenue, earned by fronting capital and taking the risk of not being
repaid. Relay, Across and deBridge work this way. CoW and UniswapX do not, since there the fill and
the payment are one atomic transaction.

## Endpoints

| Method | Path                 | Purpose                                                           |
| ------ | -------------------- | ----------------------------------------------------------------- |
| POST   | `/price`             | Indicative price, reserves nothing                                |
| POST   | `/quote`             | Executable quote with TTL, route, fees and expected profit        |
| POST   | `/orders/:id/accept` | Commits the quote, returns deposit instructions, queues the order |
| GET    | `/orders/:id`        | State, status, failReason, failDetail, depositTx, fillTx, history |
| GET    | `/orders`            | All orders (admin key in `x-api-key`)                             |
| GET    | `/swap-sources`      | Chains and their sources                                          |
| GET    | `/inventory`         | Solver balances per chain and token (admin key in `x-api-key`)    |
| GET    | `/health`            | Liveness                                                          |
| GET    | `/docs`              | Swagger                                                           |
