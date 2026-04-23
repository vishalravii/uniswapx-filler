// ============================================================
// EIP-1559 gas oracle for Arbitrum One
//
// On Arbitrum the base fee is near-zero (~0.01–0.1 gwei) and
// priority fee matters only to jump the sequencer queue (rarely needed).
// We refresh every block and expose ready-to-use feeData.
// ============================================================
import { ethers }           from 'ethers';
import { getHttpProvider }  from './provider';
import { CONFIG }           from '../config';
import { logger }           from '../utils/logger';

export interface GasParams {
  maxFeePerGas:         bigint;
  maxPriorityFeePerGas: bigint;
}

const PRIORITY_FEE_GWEI = 0.01; // tiny tip — Arbitrum sequencer doesn't need more

let cached: GasParams | null = null;
let lastFetchMs = 0;
const TTL_MS = 4_000; // refresh every ~4 s (2 Arb blocks)

export async function getGasParams(): Promise<GasParams> {
  const now = Date.now();
  if (cached && now - lastFetchMs < TTL_MS) return cached;

  const provider = getHttpProvider();
  try {
    const feeData = await provider.getFeeData();
    const baseFee = feeData.gasPrice ?? ethers.parseUnits('0.1', 'gwei');
    const priorityFee = ethers.parseUnits(PRIORITY_FEE_GWEI.toString(), 'gwei');

    // maxFeePerGas = baseFee * 1.25 + priorityFee (buffer for base-fee spikes)
    const maxFee = (baseFee * 125n / 100n) + priorityFee;

    // Circuit-breaker: abort if gas is unreasonably high
    const gasPriceGwei = Number(baseFee) / 1e9;
    if (gasPriceGwei > CONFIG.MAX_GAS_GWEI) {
      throw new Error(`Gas spike: ${gasPriceGwei.toFixed(3)} gwei > max ${CONFIG.MAX_GAS_GWEI}`);
    }

    cached = { maxFeePerGas: maxFee, maxPriorityFeePerGas: priorityFee };
    lastFetchMs = now;
    return cached;
  } catch (err) {
    if (cached) {
      logger.warn('[gas] Using stale gas params', err);
      return cached;
    }
    throw err;
  }
}

/** USD cost estimate for a fill transaction */
export function estimateGasCostUsd(gasLimit: bigint, params: GasParams, ethPriceUsd: number): number {
  const costWei = gasLimit * params.maxFeePerGas;
  return (Number(costWei) / 1e18) * ethPriceUsd;
}
