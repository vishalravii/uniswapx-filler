// ============================================================
// ERC-20 approval manager
//
// The UniswapX reactor uses safeTransferFrom to pull output tokens
// from the filler (msg.sender). The filler must approve the reactor
// contract to spend each output token BEFORE calling execute().
//
// This module checks approvals on startup and re-approves lazily
// when a fill would fail due to insufficient allowance.
// ============================================================
import { ethers } from 'ethers';
import { logger } from '../utils/logger';

const ERC20_ABI = [
  'function allowance(address owner, address spender) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function symbol() external view returns (string)',
] as const;

// Cache approved (reactor, token) pairs to avoid redundant on-chain reads
const approvedSet = new Set<string>(); // `${reactorAddress}|${tokenAddress}`

function approvalKey(reactor: string, token: string): string {
  return `${reactor.toLowerCase()}|${token.toLowerCase()}`;
}

/**
 * Ensure the filler wallet has approved `reactor` to spend `token`.
 * Only submits an approval transaction if the current allowance is below
 * half of MaxUint256 (handles edge cases where a previous partial approval exists).
 */
export async function ensureApproval(
  signer:  ethers.Signer,
  token:   string,
  reactor: string,
): Promise<void> {
  const key = approvalKey(reactor, token);
  if (approvedSet.has(key)) return; // already confirmed in this session

  const erc20    = new ethers.Contract(token, ERC20_ABI, signer);
  const owner    = await signer.getAddress();
  const current  = await erc20.allowance(owner, reactor) as bigint;

  // Consider approved if current allowance > half of MaxUint256
  if (current > ethers.MaxUint256 / 2n) {
    approvedSet.add(key);
    return;
  }

  let symbol = token.slice(0, 10);
  try { symbol = await erc20.symbol() as string; } catch { /* non-standard token */ }

  logger.info(`[approvals] Approving ${symbol} (${token}) for reactor ${reactor}`);

  const tx = await erc20.approve(reactor, ethers.MaxUint256) as ethers.TransactionResponse;
  const receipt = await tx.wait(1);
  if (!receipt || receipt.status !== 1) {
    throw new Error(`[approvals] Approval tx failed for ${symbol}`);
  }

  approvedSet.add(key);
  logger.info(`[approvals] ${symbol} approved — txHash=${receipt.hash}`);
}

/**
 * Bulk-approve a list of tokens for a reactor at startup.
 * Errors are logged but not thrown — missing approvals will be caught fill-time.
 */
export async function ensureApprovals(
  signer:  ethers.Signer,
  tokens:  string[],
  reactor: string,
): Promise<void> {
  for (const token of tokens) {
    try {
      await ensureApproval(signer, token, reactor);
    } catch (err) {
      logger.error(`[approvals] Failed to approve ${token}`, err);
    }
  }
}
