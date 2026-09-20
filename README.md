# Solver Engine

A cross-chain fill-then-settle solver. Given an intent such as selling 1 WETH on Arbitrum for USDC
on Base, it prices the trade against real pool state on both chains, waits for the user's deposit,
pays the user with a signed transaction, and settles once the deposit is final.

- Pool addresses are derived with CREATE2 and read from mainnet, never from a subgraph or a list.
- Output amounts come from our own Uniswap V2 and V3 implementations, which match QuoterV2 to the wei.
- Gas is a transaction receipt on a fork or `estimateGas` on the live chain, never an estimate of our own.
- Fills, refunds and rebalances are signed transactions, on anvil forks of the chains or on the chains themselves.

![Architecture](src/assets/architecture.png)

## What a solver is

A solver is a market maker that buys a user's deposit at a discount. The user sends 10,000 USDC on
Base, the solver pays them ETH on Arbitrum out of its own inventory, and collects the 10,000 USDC
afterwards. The spread is its revenue, earned by fronting capital and taking the risk of not being
repaid. Relay, Across and deBridge work this way. CoW and UniswapX do not, since there the fill and
the payment are one atomic transaction.

## How it works

### Chains and AMMs

Registry entries. A chain is an RPC, a block time and its hub tokens. An AMM is a factory, a
deployer, an init code hash, fee tiers and a router.

### Pools

Every candidate pool address for a pair is derived with CREATE2 and probed in one multicall. The
three deepest are loaded with their ticks; the rest are tracked by liquidity. After that, one
`eth_getLogs` per chain per block replays `Swap`, `Mint`, `Burn` and `Sync` events, watches the
factories for new pools, and re-selects the deepest three when the ranking changes.

### Quoting

Same chain: direct pools and one hop through each hub token, ranked on net output after gas.
Cross chain: join the two chains on a shared hub asset, value the deposit into it on the origin,
cross one to one, swap on the destination.

```
quotedOut = grossOut - fillGas - settlement - rebalance - riskBuffer - serviceFee - appFee
```

The risk buffer covers the time the quote is held open (deposit window plus origin confirmations)
and scales with the square root of that wait. A quote is refused when the result is not positive,
unprofitable, under the user's minimum, or needs more destination inventory than the solver holds.
The intent is priced again before the fill; a move larger than the buffer is refunded.

### Deposits

A deposit is an ERC20 transfer to the solver's address, matched by `Transfer` log and claimed by
`txHash:logIndex`. Each waiting order on a chain and token is given a distinct amount, so a
transfer matches one order. Payout at two confirmations, settlement at six, the log re-read at its
block each time. Refunds go to the `refundTo` given with the intent, or to the depositor. A
transfer that lands after the window or matches no order is returned to its sender if the token is
one the solver deals in and the amount is worth more than the gas to send it back.

### Execution

The fill engine swaps into the solver's own account, checks the output against the quote, then
pays the user. Everything after accept is one BullMQ job per order; the order state machine, not
the job ID, prevents a double fill. A fill that cannot happen refunds the deposit. A swap that
went through but did not pay out retries the payout only.

### Persistence

Orders, intents, quotes and inventory are written to Redis before any caller sees them and read
back on start, next to the BullMQ jobs, so a restart resumes every order. An order that was
mid-transaction is checked against the chain: a payout or refund found there is carried on from;
one that cannot be found puts the order in `NEEDS_REVIEW`.

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
