/**
 * Shared Relay.link quote/v2 fetch + approve/deposit parsing (used by e2e scripts).
 */
import axios from 'axios';
import { ethers } from 'ethers';

import { RELAY_API_KEY } from '../config';

export interface RelayQuoteResponse {
  steps: RelayStep[];
}

interface RelayStep {
  items: Array<{
    data: {
      to?: string;
      data?: string;
    };
  }>;
}

export async function fetchRelayQuoteV2(params: {
  routerAddress: string;
  recipient: string;
  originChainId: number;
  destinationChainId: number;
  originCurrency: string;
  destinationCurrency: string;
  amount: bigint;
}): Promise<RelayQuoteResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (RELAY_API_KEY) {
    headers['x-api-key'] = RELAY_API_KEY;
  }

  const body = {
    user: params.routerAddress,
    recipient: params.recipient,
    originChainId: params.originChainId,
    destinationChainId: params.destinationChainId,
    originCurrency: params.originCurrency,
    destinationCurrency: params.destinationCurrency,
    tradeType: 'EXACT_INPUT',
    amount: params.amount.toString(),
  };

  const response = await axios.post<RelayQuoteResponse>(
    'https://api.relay.link/quote/v2',
    body,
    { headers },
  );
  return response.data;
}

export function parseRelayQuote(quote: RelayQuoteResponse): {
  relaySpender: string;
  depositTarget: string;
  depositData: string;
} {
  const approveIface = new ethers.Interface([
    'function approve(address spender, uint256 amount) external returns (bool)',
  ]);

  const approveStep = quote.steps[0];
  const approveDataHex = approveStep.items[0].data.data ?? '';
  let relaySpender: string;
  try {
    relaySpender = ethers.getAddress(
      approveIface.decodeFunctionData('approve', approveDataHex)[0],
    );
  } catch {
    const normalized = approveDataHex.startsWith('0x') ? approveDataHex.slice(2) : approveDataHex;
    if (normalized.length < 8 + 64) {
      throw new Error('Relay approve step calldata too short for fallback spender parse');
    }
    const spender40 = normalized.slice(8 + 24, 8 + 24 + 40);
    relaySpender = ethers.getAddress('0x' + spender40);
  }

  const depositStep = quote.steps[1];
  const depositItem = depositStep.items[0].data;
  const depositTarget = depositItem.to ?? '';
  const depositData = depositItem.data ?? '0x';

  return { relaySpender, depositTarget, depositData };
}
