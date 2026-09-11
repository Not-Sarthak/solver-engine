import { parseAbiItem, type Address, type Hash, type PublicClient } from "viem";
import { logger } from "../lib/logger";
import { getLogsInRanges } from "./client";

// where a deposit landed, so it can be found again. a deposit is identified by its log, not by its
// amount: two orders for the same amount are told apart by which transfer each one claimed.
export type Deposit = {
    chainId: number;
    token: Address;
    amount: bigint;
    txHash: Hash;
    logIndex: number;
    blockNumber: bigint;
};

type FindDepositParams = {
    client: PublicClient;
    chainId: number;
    token: Address;
    to: Address;
    amount: bigint;
    fromBlock: bigint;
    claimed: ReadonlySet<string>;
};

// how many blocks on top before a deposit is acted on, and how many more before it is treated as
// final. one block is enough to see it; more are what make a reorg unlikely to take it back. these
// are the depth at which a fill is paid out and the depth at which the solver stops watching, and
// on a chain with fast finality they are conservative rather than wrong.
export const DEPOSIT_CONFIRMATIONS = 2n;
export const DEPOSIT_FINALITY = 6n;

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

type TransferLog = { args: { value?: bigint }; blockNumber: bigint | null; logIndex: number | null; transactionHash: Hash };

export function depositKey(deposit: Pick<Deposit, "txHash" | "logIndex">): string {
    return `${deposit.txHash}:${deposit.logIndex}`;
}

// without a depository contract there is no order id on chain, so a deposit is an erc20 transfer of
// the exact amount to the solver's own address after the order was accepted. the first such transfer
// not already claimed by another order is this order's. a depository that tags each deposit with an
// order id is what removes the ambiguity; this is the honest shape without one.
export async function findDeposit({ client, chainId, token, to, amount, fromBlock, claimed }: FindDepositParams): Promise<Deposit | null> {
    const head = await client.getBlockNumber({ cacheTime: 0 });
    const logs = await getLogsInRanges<TransferLog>(client, { address: token, event: TRANSFER, args: { to }, fromBlock, toBlock: head });

    for (const log of logs) {
        if (log.args.value !== amount || log.blockNumber === null || log.logIndex === null) {
            continue;
        }

        const deposit: Deposit = { chainId, token, amount, txHash: log.transactionHash, logIndex: log.logIndex, blockNumber: log.blockNumber };

        if (!claimed.has(depositKey(deposit))) {
            logger.info("Deposit Found: ", {
                chainId,
                token,
                amount: amount.toString(),
                txHash: deposit.txHash,
                blockNumber: deposit.blockNumber.toString(),
            });

            return deposit;
        }
    }

    return null;
}

// viem caches the head for its polling interval by default, which would report a block that has
// already moved on. depth is only ever asked for when the answer decides whether to pay out.
export async function confirmations(client: PublicClient, deposit: Deposit): Promise<bigint> {
    return (await client.getBlockNumber({ cacheTime: 0 })) - deposit.blockNumber;
}

// a reorg that drops the deposit leaves the same block number holding different transactions, so
// the check is whether the exact log is still there, not whether the block still exists
export async function stillPresent(client: PublicClient, deposit: Deposit): Promise<boolean> {
    const logs = await client.getLogs({ address: deposit.token, event: TRANSFER, fromBlock: deposit.blockNumber, toBlock: deposit.blockNumber });

    return logs.some((log) => log.transactionHash === deposit.txHash && log.logIndex === deposit.logIndex && log.args.value === deposit.amount);
}
