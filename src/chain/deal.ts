import { encodeAbiParameters, encodeFunctionData, keccak256, numberToHex, pad } from "viem";
import type { Address, PublicClient, StateOverride, TestClient } from "viem";
import { erc20Abi } from "./abis";
import { logger } from "../lib/logger";

type BalanceOverrideParams = { publicClient: PublicClient; token: Address; holder: Address; amount: bigint };
type AllowanceOverrideParams = { publicClient: PublicClient; token: Address; owner: Address; spender: Address; amount: bigint };
type DealParams = BalanceOverrideParams & { testClient: TestClient };

// solidity stores `mapping(address => uint256) balances` at slot s as keccak256(holder . s). the
// slot index differs per token and is not discoverable from the abi, so it is found by asking the
// contract what it would believe its balance was if that slot held a probe value. the search has to
// run well past the low slots: upgradeable tokens leave storage gaps, so arbitrum WETH and USD~0 both
// keep balances at slot 51 and were unfundable while the ceiling was 30.
const MAX_BALANCE_SLOT = 64;

// the state override that makes `holder` appear to own `amount` of `token`, or null when no slot
// answers. read-only: the node evaluates the probe against overridden state and nothing is written,
// which is what lets a live chain simulate a swap of a deposit the solver has not received yet.
export async function balanceOverride({ publicClient, token, holder, amount }: BalanceOverrideParams): Promise<StateOverride | null> {
    const value = pad(numberToHex(amount), { size: 32 });

    for (let slot = 0; slot <= MAX_BALANCE_SLOT; slot++) {
        const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, BigInt(slot)]));
        const override: StateOverride = [{ address: token, stateDiff: [{ slot: key, value }] }];
        const { data } = await publicClient.call({
            to: token,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [holder] }),
            stateOverride: override,
        });

        if (data !== undefined && BigInt(data) === amount) {
            return override;
        }
    }

    logger.warn("Balance Slot Not Found: ", { token, maxSlot: MAX_BALANCE_SLOT });

    return null;
}

// `mapping(address owner => mapping(address spender => uint256))` at slot s puts allowances[owner]
// [spender] at keccak256(spender . keccak256(owner . s)). found the same way, and for the same reason:
// a quote-time simulation has to see an approval the solver has not sent, because a quote must never
// cost gas. the real approval is sent once, at fill time.
export async function allowanceOverride({ publicClient, token, owner, spender, amount }: AllowanceOverrideParams): Promise<StateOverride | null> {
    const value = pad(numberToHex(amount), { size: 32 });

    for (let slot = 0; slot <= MAX_BALANCE_SLOT; slot++) {
        const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, BigInt(slot)]));
        const key = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender, inner]));
        const override: StateOverride = [{ address: token, stateDiff: [{ slot: key, value }] }];
        const { data } = await publicClient.call({
            to: token,
            data: encodeFunctionData({ abi: erc20Abi, functionName: "allowance", args: [owner, spender] }),
            stateOverride: override,
        });

        if (data !== undefined && BigInt(data) === amount) {
            return override;
        }
    }

    logger.warn("Allowance Slot Not Found: ", { token, maxSlot: MAX_BALANCE_SLOT });

    return null;
}

// the same slot, written for real. only a fork can do this, and it is how inventory gets there
// without buying it on the market and moving the very pools the solver is about to quote.
export async function dealToken({ publicClient, testClient, token, holder, amount }: DealParams): Promise<boolean> {
    const override = await balanceOverride({ publicClient, token, holder, amount });

    if (override === null) {
        return false;
    }

    const { slot, value } = override[0]!.stateDiff![0]!;
    await testClient.setStorageAt({ address: token, index: slot, value });

    return true;
}
