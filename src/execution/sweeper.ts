import { parseAbiItem, type Address, type Hash, type PublicClient } from "viem";
import { getLogsInRanges } from "../chain/client";
import { DEPOSIT_FINALITY, depositKey } from "../chain/deposits";
import { isSameAddress } from "../lib/address";
import { logger } from "../lib/logger";
import type { Records } from "../orders/records";
import type { FillEngine } from "./fill-engine";

// a transfer to the solver that no order accounts for: the wrong amount, the right amount after
// its order expired, a token nobody asked for. it is somebody's money and it goes back to them.
export type Stray = {
    key: string;
    chainId: number;
    token: Address;
    from: Address;
    amount: bigint;
    txHash: Hash;
    logIndex: number;
    blockNumber: bigint;
    refundTx: Hash | null;
    detail: string | null;
    // how many times a refund was tried; past the cap it is left for an operator
    attempts: number;
    // not refunded and not going to be, with `detail` saying why: an unknown token, an amount
    // worth less than its gas, or too many failed sends. kept so a person can act on it.
    abandoned: boolean;
};

export type Cursor = { chainId: number; sweptTo: bigint };

type SweeperParams = {
    chainId: number;
    client: PublicClient;
    fillEngine: FillEngine;
    solver: Address;
    // where to start when nothing has been swept yet: the block the solver came up at
    fromBlock: bigint;
    // deposits that were matched to an order, and the orders still able to match one
    claimed: ReadonlySet<string>;
    claimable(transfer: { token: Address; amount: bigint; blockNumber: bigint }): boolean;
    // senders whose transfers are the operator's own top-ups, never a deposit
    ignoreFrom: readonly Address[];
    // the tokens the solver deals in on this chain. anything else is not refunded: anyone can
    // mint a token and send it here, and a refund of it is gas spent for nothing, or a call into
    // code the attacker wrote.
    isKnownToken(token: Address): boolean;
    // the gas a refund of this token would cost, in units of that token, or null when the token
    // cannot be priced. a refund worth less than its own gas is not sent.
    refundGasCost(token: Address, amount: bigint): Promise<bigint | null>;
    // refund attempts before a stray is left for an operator
    maxAttempts: number;
    records: { strays: Records<Stray>; cursors: Records<Cursor> };
};

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

type TransferLog = {
    address: Address;
    args: { from?: Address; value?: bigint };
    blockNumber: bigint | null;
    logIndex: number | null;
    transactionHash: Hash;
};

// a transfer is only judged stray once it is as deep as a deposit has to be to settle. before
// that an order may still claim it, or a reorg may still take it away, and the sweeper would be
// refunding something it does not yet know the shape of.
const SWEEP_LAG_BLOCKS = DEPOSIT_FINALITY;

export function createSweeper({
    chainId,
    client,
    fillEngine,
    solver,
    fromBlock,
    claimed,
    claimable,
    ignoreFrom,
    isKnownToken,
    refundGasCost,
    maxAttempts,
    records,
}: SweeperParams) {
    const strays = new Map<string, Stray>();
    let sweptTo: bigint | null = null;
    let sweeping: Promise<number> | null = null;

    async function restore(): Promise<void> {
        for (const stray of await records.strays.loadAll()) {
            if (stray.chainId === chainId) {
                strays.set(stray.key, stray);
            }
        }

        const cursor = (await records.cursors.loadAll()).find((candidate) => candidate.chainId === chainId);
        sweptTo = cursor?.sweptTo ?? fromBlock - 1n;
    }

    // the solver's own transactions move tokens into its account too: every swap output arrives as
    // a transfer to it. those are told apart by who sent the transaction, not by who sent the token.
    async function sentBySolver(txHash: Hash): Promise<boolean> {
        const transaction = await client.getTransaction({ hash: txHash });

        return isSameAddress(transaction.from, solver);
    }

    async function refund(stray: Stray): Promise<Stray> {
        const attempts = stray.attempts + 1;
        const sent = await fillEngine.fill({
            orderId: `stray:${stray.key}`,
            legs: [],
            tokenOut: stray.token,
            recipient: stray.from,
            amountIn: stray.amount,
            minAmountOut: 0n,
            payoutAmount: stray.amount,
        });

        const updated: Stray = sent.ok
            ? { ...stray, attempts, refundTx: sent.measurement.txHash, detail: null }
            : { ...stray, attempts, detail: sent.detail, abandoned: attempts >= maxAttempts };

        if (sent.ok) {
            logger.info("Stray Refunded: ", {
                chainId,
                token: stray.token,
                from: stray.from,
                amount: stray.amount.toString(),
                txHash: sent.measurement.txHash,
            });
        } else {
            logger.warn(updated.abandoned ? "Stray Abandoned: " : "Stray Refund Failed: ", {
                chainId,
                key: stray.key,
                attempts,
                reason: sent.reason,
                detail: sent.detail,
            });
        }

        await records.strays.save(updated.key, updated);
        strays.set(updated.key, updated);

        return updated;
    }

    async function scan(): Promise<number> {
        if (sweptTo === null) {
            throw new Error(`Sweeper for chain ${chainId} was not restored`);
        }

        const head = await client.getBlockNumber({ cacheTime: 0 });
        const toBlock = head - SWEEP_LAG_BLOCKS;
        const logs =
            toBlock <= sweptTo
                ? []
                : await getLogsInRanges<TransferLog>(client, { event: TRANSFER, args: { to: solver }, fromBlock: sweptTo + 1n, toBlock });
        let found = 0;

        for (const log of logs) {
            if (log.args.from === undefined || log.args.value === undefined || log.blockNumber === null || log.logIndex === null) {
                continue;
            }

            const key = depositKey({ txHash: log.transactionHash, logIndex: log.logIndex });
            const transfer = { token: log.address, amount: log.args.value, blockNumber: log.blockNumber };

            if (claimed.has(key) || strays.has(key) || claimable(transfer) || ignoreFrom.some((address) => isSameAddress(address, log.args.from!))) {
                continue;
            }

            if (await sentBySolver(log.transactionHash)) {
                continue;
            }

            const stray: Stray = {
                key,
                chainId,
                token: log.address,
                from: log.args.from,
                amount: log.args.value,
                txHash: log.transactionHash,
                logIndex: log.logIndex,
                blockNumber: log.blockNumber,
                refundTx: null,
                detail: null,
                attempts: 0,
                abandoned: false,
            };

            // a transfer the sweeper will not send back is still recorded, with the reason: a user
            // who deposited a token this solver does not deal in has to be findable later
            const known = isKnownToken(log.address);
            const gasCost = known ? await refundGasCost(log.address, log.args.value) : null;
            const held = !known
                ? "unknown token"
                : gasCost === null
                  ? "cannot be priced"
                  : log.args.value <= gasCost
                    ? `worth less than the ${gasCost} it costs to send back`
                    : null;

            if (held !== null) {
                const kept = { ...stray, abandoned: true, detail: held };

                logger.warn("Stray Held: ", {
                    chainId,
                    token: kept.token,
                    from: kept.from,
                    amount: kept.amount.toString(),
                    txHash: kept.txHash,
                    detail: held,
                });
                await records.strays.save(key, kept);
                strays.set(key, kept);
                continue;
            }

            logger.warn("Stray Deposit: ", { chainId, token: stray.token, from: stray.from, amount: stray.amount.toString(), txHash: stray.txHash });
            await records.strays.save(key, stray);
            strays.set(key, stray);
            found++;
        }

        if (toBlock > sweptTo) {
            sweptTo = toBlock;
            await records.cursors.save(String(chainId), { chainId, sweptTo });
        }

        // every stray not yet given back, including ones a previous sweep failed to send, until
        // the attempts run out
        for (const stray of strays.values()) {
            if (stray.refundTx === null && !stray.abandoned) {
                await refund(stray);
            }
        }

        return found;
    }

    // one sweep at a time, or two would find and refund the same transfer
    function sweep(): Promise<number> {
        if (sweeping === null) {
            sweeping = scan().finally(() => (sweeping = null));
        }

        return sweeping;
    }

    return { restore, sweep, strays: () => [...strays.values()] };
}
