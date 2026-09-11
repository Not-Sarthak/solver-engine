# Solver Engine

A cross-chain fill-then-settle solver. Given an intent such as selling 1 WETH on Arbitrum for USDC
on Base, it prices the trade against real pool state on both chains, waits for the user's deposit,
pays the user with a signed transaction, and settles once the deposit is final.

Pool addresses are derived with CREATE2 and read from mainnet. Output amounts come from our own
Uniswap V2 and V3 implementations, which match Uniswap's QuoterV2 to the wei. Gas comes from a
transaction receipt on a fork or from `estimateGas` on the live chain. Fills are real transactions.

![Architecture](src/assets/architecture.png)

## What a solver is

A solver is a market maker that buys a user's deposit at a discount. The user sends 10,000 USDC on
Base, the solver pays them ETH on Arbitrum out of its own inventory, and collects the 10,000 USDC
afterwards. The spread is its revenue, earned by fronting capital and taking the risk of not being
repaid. Relay, Across and deBridge work this way. CoW and UniswapX do not, since there the fill and
the payment are one atomic transaction.

## A run

1 WETH into USDC on Base, against an anvil fork at block 51167991.

`POST /quote`

```json
{
  "orderId": "6e98f3dd-205f-4c39-b553-d6dc66a90df1",
  "quote": {
    "amountOut": "2450117708",
    "expectedProfit": "4418170",
    "expiresAtMs": 1789125924432,
    "fees": {
      "relayerGas": "3966",
      "relayerService": "1963631",
      "app": "0",
      "settlement": "0",
      "rebalance": "0",
      "riskBuffer": "2454539"
    },
    "route": {
      "hops": 1,
      "grossAmountOut": "2454539844",
      "gasUsed": "268866",
      "legs": [
        {
          "sourceId": "concentrated-liquidity",
          "poolId": "0x72AB388E2E2F6FaceF59E3C3FA2C4E29011c2D38",
          "tokenIn": "0x4200000000000000000000000000000000000006",
          "tokenOut": "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
          "amountOut": "2454539844",
          "latencyMs": 2.286
        }
      ]
    }
  }
}
```

`POST /orders/6e98f3dd-205f-4c39-b553-d6dc66a90df1/accept`

```json
{
  "deposit": {
    "chainId": 8453,
    "token": "0x4200000000000000000000000000000000000006",
    "amount": "1000000000000000000",
    "to": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
  },
  "jobId": "6e98f3dd-205f-4c39-b553-d6dc66a90df1",
  "order": { "state": "AWAITING_DEPOSIT", "status": "waiting" }
}
```

`GET /orders/6e98f3dd-205f-4c39-b553-d6dc66a90df1`

```json
{
  "status": "success",
  "state": "SETTLED",
  "failReason": null,
  "failDetail": null,
  "depositTx": "0xc8ce13560a22a469249222b3dfb1d7989d834b5b858c3ed95ea4b70c7acc1df1",
  "fillTx": "0xef8841cd7e29d44a587406edb1c72112ceb670a005a4f5fce77170d7b6a4d0bc",
  "history": [
    "RECEIVED", "QUOTING", "QUOTED", "ACCEPTED", "AWAITING_DEPOSIT", "DEPOSIT_CONFIRMED",
    "FILLING", "FILLED", "SETTLING", "SETTLEMENT_FAILED", "SETTLING", "SETTLEMENT_FAILED",
    "SETTLING", "SETTLED"
  ]
}
```

## How it works

Chains and AMMs are registry entries: RPC, block time, hub tokens, and for each AMM its factory,
deployer, init code hash, fee tiers and router. Adding one is a data change.

A pair's pools are found by deriving every CREATE2 candidate address and probing them in one
multicall. The three deepest are loaded with their ticks, the rest are tracked by liquidity. From
then on nothing is re-read: one `eth_getLogs` per chain per block replays the pools' own events,
factories are watched for new pools, and the deepest three are re-selected when the ranking
changes.

A single-chain quote searches direct pools and one hop through each hub token and ranks on net
output after gas. A cross-chain quote joins the two chains on a shared hub asset, values the
deposit into it on the origin, crosses one to one, and swaps on the destination.

```
quotedOut = grossOut - fillGas - settlement - rebalance - riskBuffer - serviceFee - appFee
```

The solver refuses when the result is not positive, unprofitable, under the user's minimum, or
would spend more destination inventory than it holds.

Deposits are ERC20 transfers to the solver's address, matched by `Transfer` log and claimed by
`txHash:logIndex`. The amount the user is asked to send is unique among the orders waiting on that
token on that chain: a second order for the same amount is asked for one more base unit, so a
transfer matches exactly one order without an order ID on chain. Payout happens at two
confirmations, settlement at six, with the log re-read at its block each time.

The fill engine swaps into the solver's own account, checks the output against the quote, and only
then pays the user. Everything after accept is one BullMQ job per order; the order state machine,
not the job ID, is what prevents a double fill.

Orders, intents and quotes are written to Redis before any caller sees them and read back on
start, next to the BullMQ jobs that act on them, so a restart resumes every order where it was. An
order that was mid-fill when the process died is reported and left alone, because whether its
transaction went out cannot be known from here and paying twice is worse than paying late.

## Performance

| Before                                                                       | After                                            | Change                                                                                 |
| ---------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Warm quote 173 ms, of which one `eth_gasPrice` round trip was p50 177 ms     | Warm quote 1.44 ms                               | Gas price pinned per chain and refreshed per block instead of per quote                |
| V3 swap rescanned every tick per step: 3.0 ms for 20M USDC across 1454 ticks | Warm quote 0.87 ms (together with the row below) | Ticks sorted once at load; binary search for the start tick, cursor stepped from there |
| Tick list validated on every swap: 97.9 µs, 43% of the swap                  | 1.0 µs (scalar fields only)                      | Validate once when the pool is read                                                    |
| Every candidate route executed for gas: 14.5 s per quote                     | 3 routes executed, about 1.4 s each              | Rank with our own AMM math first, execute only the top three                           |
| Failing routes re-executed every quote: about 2.5 s each                     | Not re-executed                                  | Failed gas measurements cached alongside successful ones                               |
| All candidate pools of a pair loaded with ticks                              | Deepest 3 loaded, rest tracked by liquidity      | 3 is exact against QuoterV2, 2 loses 4 bps                                             |
| Tick window of 1 bitmap word: overstates output by 7315 bps at 200M USDC     | 8 words either side: exact to 200M USDC          | Load cost 1094 ms against 779 ms                                                       |
| Pool state refreshed by reloading: about 1 s per V3 pool                     | One `eth_getLogs` per chain per block            | Replay `Swap`, `Mint`, `Burn`, `Sync`; `Swap` carries the exact post state             |
| Multicall chunks of 40: 4.70 ms per call                                     | Chunks of 400: 1.39 ms per call, 4 in flight     | Chunk size measured against the public endpoint                                        |
| Multi-hop legs sent as separate router calls: 1 of 3 routes executable       | 3 of 3 executable                                | Legs packed into a single `exactInput` path                                            |

## Endpoints

| Method | Path                 | Purpose                                                           |
| ------ | -------------------- | ----------------------------------------------------------------- |
| POST   | `/price`             | Indicative price, reserves nothing                                |
| POST   | `/quote`             | Executable quote with TTL, route, fees and expected profit        |
| POST   | `/orders/:id/accept` | Commits the quote, returns deposit instructions, queues the order |
| GET    | `/orders/:id`        | State, status, failReason, failDetail, depositTx, fillTx, history |
| GET    | `/orders`            | All orders                                                        |
| GET    | `/swap-sources`      | Chains and their sources                                          |
| GET    | `/inventory`         | Solver balances per chain and token                               |
| GET    | `/health`            | Liveness                                                          |
| GET    | `/docs`              | Swagger                                                           |
