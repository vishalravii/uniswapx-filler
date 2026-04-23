// ============================================================
// Order watcher — polls the UniswapX Orders API and emits new orders.
//
// Design decisions:
//   • HTTP polling (not WebSocket to API) — simpler, reliable, sufficient
//     at 1.5 s interval (~3 Arbitrum blocks).
//   • Deduplication by orderHash — prevents processing the same order twice.
//   • Exponential back-off on consecutive errors.
//   • Prunes the seen-set every cycle (5-min TTL) to avoid unbounded memory.
// ============================================================
import { EventEmitter } from 'events';
import axios from 'axios';

import { ApiOrder, ApiOrdersResponse, UniswapXOrder } from './types';
import { CONFIG }  from '../config';
import { logger }  from '../utils/logger';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

// ── Normalise raw API order → UniswapXOrder ───────────────────────────────────

function normalise(raw: ApiOrder): UniswapXOrder {
  let decayStartTime:  number;
  let decayEndTime:    number;
  let exclusiveFiller: string;

  if (raw.type === 'Dutch_V2' && raw.cosignerData) {
    // V2: timing lives inside cosignerData
    decayStartTime  = raw.cosignerData.decayStartTime;
    decayEndTime    = raw.cosignerData.decayEndTime;
    exclusiveFiller = raw.cosignerData.exclusiveFiller ?? ZERO_ADDRESS;
  } else {
    // V1 ExclusiveDutchOrder: timing at top level
    const nowSecs = Math.floor(Date.now() / 1000);
    decayStartTime  = raw.decayStartTime  ?? nowSecs;
    decayEndTime    = raw.decayEndTime    ?? raw.deadline;
    exclusiveFiller = raw.exclusiveFiller ?? ZERO_ADDRESS;
  }

  return {
    ...raw,
    resolvedDecayStartTime:  decayStartTime,
    resolvedDecayEndTime:    decayEndTime,
    resolvedExclusiveFiller: exclusiveFiller,
    discoveredAtMs:          Date.now(),
  };
}

// ── OrderWatcher ─────────────────────────────────────────────────────────────

export declare interface OrderWatcher {
  on(event: 'order', listener: (order: UniswapXOrder) => void): this;
  emit(event: 'order', order: UniswapXOrder): boolean;
}

export class OrderWatcher extends EventEmitter {
  /** orderHash → time first seen (ms) */
  private readonly seen = new Map<string, number>();
  private pollTimer?: NodeJS.Timeout;
  private running = false;
  private consecutiveErrors = 0;

  start(): void {
    if (this.running) return;
    this.running = true;
    logger.info('[watcher] Starting UniswapX order watcher');
    void this.poll();
  }

  stop(): void {
    this.running = false;
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = undefined; }
    logger.info('[watcher] Order watcher stopped');
  }

  seenCount(): number { return this.seen.size; }

  // ── Internal ──────────────────────────────────────────────────────────────

  private scheduleNext(): void {
    if (!this.running) return;
    const delay = this.consecutiveErrors > 0
      ? Math.min(MAX_BACKOFF_MS, CONFIG.POLL_INTERVAL_MS * Math.pow(2, this.consecutiveErrors))
      : CONFIG.POLL_INTERVAL_MS;
    this.pollTimer = setTimeout(() => { void this.poll(); }, delay);
  }

  private async poll(): Promise<void> {
    try {
      const url = buildUrl();
      const resp = await axios.get<ApiOrdersResponse>(url, {
        timeout: 8_000,
        headers: { Accept: 'application/json' },
      });

      const rawOrders: ApiOrder[] = resp.data.orders ?? [];
      this.consecutiveErrors = 0;
      this.pruneOldSeen();

      let newCount = 0;
      const nowSecs = Math.floor(Date.now() / 1000);

      for (const raw of rawOrders) {
        if (this.seen.has(raw.orderHash)) continue;
        this.seen.set(raw.orderHash, Date.now());

        // ── Pre-flight validation ───────────────────────────────────────────
        if (raw.orderStatus !== 'open')             continue; // not fillable
        if (raw.chainId     !== CONFIG.CHAIN_ID)    continue; // wrong chain
        if (raw.deadline    <= nowSecs)             continue; // already expired
        if (!CONFIG.TRUSTED_REACTORS.has(raw.reactor.toLowerCase())) {
          logger.debug(`[watcher] Unknown reactor ${raw.reactor} — skipping`);
          continue;
        }
        if (!raw.encodedOrder || !raw.signature)    continue; // malformed
        if (!raw.outputs || raw.outputs.length === 0) continue; // no outputs

        const order = normalise(raw);
        newCount++;
        this.emit('order', order);
      }

      if (newCount > 0) {
        logger.debug(`[watcher] ${newCount} new order(s) — seen total: ${this.seen.size}`);
      }
    } catch (err: unknown) {
      this.consecutiveErrors++;
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[watcher] Poll error #${this.consecutiveErrors}: ${msg}`);
    } finally {
      this.scheduleNext();
    }
  }

  private pruneOldSeen(): void {
    const cutoff = Date.now() - SEEN_TTL_MS;
    for (const [hash, ts] of this.seen) {
      if (ts < cutoff) this.seen.delete(hash);
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const MAX_BACKOFF_MS = 30_000;
const SEEN_TTL_MS    =  5 * 60 * 1_000; // 5 minutes

function buildUrl(): string {
  const params = new URLSearchParams({
    chainId:     String(CONFIG.CHAIN_ID),
    orderStatus: 'open',
    sortKey:     'createdAt',
    desc:        'true',
    limit:       '50',
  });
  return `${CONFIG.UNISWAPX_API}?${params.toString()}`;
}
