// ============================================================
// Fill executor
//
// Responsibilities:
//   1. Re-validate order hasn't expired or been filled.
//   2. Ensure output-token approval is set.
//   3. Build the SignedOrder struct and call reactor.execute().
//   4. Wait for one confirmation, then report success/failure to metrics.
//   5. On failure: classify error (race-lost vs real error), reset nonce
//      if needed, record loss if gas was spent.
//
// Concurrency: the caller (index.ts) limits parallel fills via
// MAX_CONCURRENT_FILLS. This module is intentionally stateless.
// ============================================================
import { ethers }               from 'ethers';
import { CONFIG }               from '../config';
import { UniswapXOrder }        from '../orders/types';
import { secsUntilExpiry }      from '../orders/decay';
import { ProfitabilityResult }  from './profitability';
import { ensureApproval }       from './approvals';
import { getGasParams }         from '../chain/gas';
import { NonceManager }         from '../chain/nonce';
import { getSubmitProvider }    from '../chain/provider';
import { metrics }              from '../monitoring/metrics';
import { logger }               from '../utils/logger';

// ── Reactor ABI ───────────────────────────────────────────────────────────────
// SignedOrder struct: { bytes order; bytes sig }
const REACTOR_ABI = [
  'function execute((bytes order, bytes sig) signedOrder) external payable',
] as const;

// ERC-20 balance check
const ERC20_BALANCE_ABI = [
  'function balanceOf(address account) external view returns (uint256)',
] as const;

// ── Result type ───────────────────────────────────────────────────────────────

export type FillOutcome =
  | { success: true;  txHash: string; gasUsedUsd: number; netProfitUsd: number }
  | { success: false; reason: string; gasUsedUsd?: number };

// ── Main fill function ────────────────────────────────────────────────────────

export async function fillOrder(
  order:        UniswapXOrder,
  profitResult: ProfitabilityResult,
  signer:       ethers.Wallet,
  nonceManager: NonceManager,
): Promise<FillOutcome> {
  const hash = order.orderHash.slice(0, 16);

  // ── 1. Re-check expiry (order may have aged while we were quoting) ────────
  const secsLeft = secsUntilExpiry(order);
  if (secsLeft <= 5) {
    return { success: false, reason: 'expired before fill' };
  }

  // ── 2. Check we have enough output token ──────────────────────────────────
  const outputToken   = order.outputs[0].token;
  const outputAmount  = profitResult.resolvedOutputAmount;
  const submitProv    = getSubmitProvider();

  const erc20    = new ethers.Contract(outputToken, ERC20_BALANCE_ABI, submitProv);
  const balance  = await erc20.balanceOf(signer.address) as bigint;
  if (balance < outputAmount) {
    const deficit = outputAmount - balance;
    return { success: false, reason: `insufficient ${outputToken} balance — need ${outputAmount}, have ${balance} (deficit ${deficit})` };
  }

  // ── 3. Ensure approval ────────────────────────────────────────────────────
  const signerWithSubmit = signer.connect(submitProv);
  try {
    await ensureApproval(signerWithSubmit, outputToken, order.reactor);
  } catch (err) {
    return { success: false, reason: `approval failed: ${(err as Error).message}` };
  }

  // ── 4. Gas params ─────────────────────────────────────────────────────────
  let gasParams;
  try {
    gasParams = await getGasParams();
  } catch (err) {
    return { success: false, reason: `gas spike: ${(err as Error).message}` };
  }

  // ── 5. Build and submit transaction ──────────────────────────────────────
  const reactor = new ethers.Contract(order.reactor, REACTOR_ABI, signerWithSubmit);
  const nonce   = nonceManager.next();

  const gasLimit = profitResult.quote?.isMultiHop
    ? CONFIG.GAS_LIMIT_FILL
    : CONFIG.GAS_LIMIT_FILL * 3n / 4n;

  logger.info(
    `[filler] Submitting fill for ${hash}… ` +
    `net=$${profitResult.netProfitUsd.toFixed(4)} ` +
    `gasLimit=${gasLimit} nonce=${nonce}`,
  );

  const t0 = Date.now();
  let tx: ethers.TransactionResponse;
  try {
    tx = await reactor.execute(
      { order: order.encodedOrder, sig: order.signature },
      {
        gasLimit,
        maxFeePerGas:         gasParams.maxFeePerGas,
        maxPriorityFeePerGas: gasParams.maxPriorityFeePerGas,
        nonce,
      },
    ) as ethers.TransactionResponse;
  } catch (err: unknown) {
    // Submission failed — roll back nonce (tx never reached the chain)
    nonceManager.rollback();
    const msg = extractRevertReason(err);
    if (isRaceLost(msg)) {
      metrics.recordRaceLost();
      return { success: false, reason: `race lost: ${msg}` };
    }
    return { success: false, reason: `submit error: ${msg}` };
  }

  logger.info(`[filler] Tx submitted txHash=${tx.hash}  (${Date.now() - t0} ms)`);

  // ── 6. Wait for confirmation ──────────────────────────────────────────────
  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await tx.wait(1);
  } catch (err) {
    // Tx reverted on-chain — gas IS spent
    const msg = extractRevertReason(err);
    const gasUsedUsd = estimateGasUsedUsd(gasParams.maxFeePerGas, gasLimit);
    await nonceManager.reset();
    metrics.recordLoss(gasUsedUsd);
    return { success: false, reason: `reverted: ${msg}`, gasUsedUsd };
  }

  if (!receipt || receipt.status !== 1) {
    const gasUsedUsd = estimateGasUsedUsd(gasParams.maxFeePerGas, BigInt(receipt?.gasUsed ?? gasLimit));
    await nonceManager.reset();
    metrics.recordLoss(gasUsedUsd);
    return { success: false, reason: 'receipt status=0 (reverted)', gasUsedUsd };
  }

  const latencyMs  = Date.now() - order.discoveredAtMs;
  const gasUsedUsd = estimateGasUsedUsd(gasParams.maxFeePerGas, BigInt(receipt.gasUsed));
  const netProfit  = profitResult.grossProfitUsd - gasUsedUsd;

  logger.info(
    `[filler] ✅ Filled ${hash}… ` +
    `net=$${netProfit.toFixed(4)} gasUsed=${receipt.gasUsed} latency=${latencyMs}ms ` +
    `txHash=${receipt.hash}`,
  );

  metrics.recordFill({ netProfitUsd: netProfit, latencyMs, gasUsedUsd });
  return { success: true, txHash: receipt.hash, gasUsedUsd, netProfitUsd: netProfit };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractRevertReason(err: unknown): string {
  if (err instanceof Error) return err.message.split('\n')[0].slice(0, 120);
  return String(err).slice(0, 120);
}

/** Known revert messages that indicate we lost a race (another filler got there first). */
function isRaceLost(msg: string): boolean {
  const patterns = [
    'OrderAlreadyFilled',
    'InvalidOrderFields',
    'already filled',
    'execution reverted',
    'nonce already used',
  ];
  const lower = msg.toLowerCase();
  return patterns.some(p => lower.includes(p.toLowerCase()));
}

function estimateGasUsedUsd(maxFeePerGas: bigint, gasUsed: bigint): number {
  // Rough: 1 ETH = $2400 default; actual eth price not fetched here to avoid async
  const costWei = maxFeePerGas * gasUsed;
  return (Number(costWei) / 1e18) * 2_400;
}
