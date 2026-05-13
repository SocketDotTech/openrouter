/**
 * TypeScript interfaces that mirror every Solidity struct in
 * Combined unchecked router. The order and field names must match the ABI
 * produced by the compiler so that ethers.js can encode them correctly.
 */

// ─── Monolithic execution types ───────────────────────────────────────────────

export interface InputData {
  user: string;
  inputToken: string;
  inputAmount: bigint;
}

export interface FeeData {
  receiver: string;
  amount: bigint;
}

export interface SwapData {
  target: string;
  approvalSpender: string;
  outputToken: string;
  value: bigint;
  minOutput: bigint;
  data: string;
  returnDataWordOffset: bigint;
}

export interface BridgeData {
  target: string;
  approvalSpender: string;
  value: bigint;
  data: string;
  amountPositions: bigint[];
  useFinalAmountAsValue: boolean;
}

export interface MonolithicExecution {
  input: InputData;
  preFee: FeeData;
  swap: SwapData;
  postFee: FeeData;
  bridge: BridgeData;
}

// ─── Sentinel / zero helpers ──────────────────────────────────────────────────

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** Convenience: empty fee (no fee taken) */
export const NO_FEE: FeeData = { receiver: ZERO_ADDRESS, amount: 0n };

/** Convenience: empty swap (skip swap step) */
export const NO_SWAP: SwapData = {
  target: ZERO_ADDRESS,
  approvalSpender: ZERO_ADDRESS,
  outputToken: ZERO_ADDRESS,
  value: 0n,
  minOutput: 0n,
  data: '0x',
  returnDataWordOffset: 0n,
};
