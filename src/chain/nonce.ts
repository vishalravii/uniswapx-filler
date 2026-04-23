// ============================================================
// In-memory nonce manager
//
// Why: calling eth_getTransactionCount on every fill adds ~50–150 ms of
// latency and can stall under heavy load. We maintain a local nonce
// counter and only refresh from the chain after an error or at startup.
// ============================================================
import { ethers } from 'ethers';
import { logger }  from '../utils/logger';

export class NonceManager {
  private nonce: number | null = null;
  private address: string;
  private provider: ethers.JsonRpcProvider;
  private refreshPending = false;

  constructor(address: string, provider: ethers.JsonRpcProvider) {
    this.address  = address;
    this.provider = provider;
  }

  /** Fetch current nonce from chain. Must be called before first use. */
  async init(): Promise<void> {
    this.nonce = await this.provider.getTransactionCount(this.address, 'pending');
    logger.info(`[nonce] Initialised at ${this.nonce} for ${this.address}`);
  }

  /** Return next nonce to use, incrementing the local counter. */
  next(): number {
    if (this.nonce === null) throw new Error('[nonce] NonceManager not initialised — call init() first');
    return this.nonce++;
  }

  /** Peek the current value without consuming it. */
  peek(): number {
    if (this.nonce === null) throw new Error('[nonce] NonceManager not initialised');
    return this.nonce;
  }

  /**
   * Hard-reset from chain. Call when a transaction fails with "nonce too low"
   * or after a detected reorg. Debounced — only one refresh runs at a time.
   */
  async reset(): Promise<void> {
    if (this.refreshPending) return;
    this.refreshPending = true;
    try {
      const onChain = await this.provider.getTransactionCount(this.address, 'pending');
      logger.warn(`[nonce] Reset from ${this.nonce} → ${onChain}`);
      this.nonce = onChain;
    } catch (e) {
      logger.error('[nonce] Reset failed', e);
    } finally {
      this.refreshPending = false;
    }
  }

  /**
   * Roll back by one. Call when a transaction was rejected synchronously
   * (e.g. balance too low) so the nonce slot isn't wasted.
   */
  rollback(): void {
    if (this.nonce !== null && this.nonce > 0) {
      this.nonce--;
      logger.debug(`[nonce] Rolled back to ${this.nonce}`);
    }
  }
}
