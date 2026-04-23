// ============================================================
// Risk circuit-breaker
//
// Protections:
//   • Daily USD loss limit — pauses for 1 hour when breached.
//   • Token blacklist — permanently skip specific token addresses
//     (e.g. known honeypots or rebase tokens that break accounting).
//   • Concurrent fill cap — prevents runaway parallel submissions.
//   • Gas spike guard — checked separately in gas.ts / profitability.ts.
// ============================================================
import { CONFIG } from '../config';
import { logger } from '../utils/logger';

const PAUSE_DURATION_MS = 60 * 60 * 1_000; // 1 hour

class RiskGuard {
  private dailyLossUsd    = 0;
  private paused          = false;
  private pauseUntil      = 0;
  private activeFills     = 0;
  private lastDayReset    = todayUtcDate();

  // Optional token blacklist loaded from env (comma-separated addresses)
  private readonly blacklist: Set<string> = parseBlacklist();

  // ── Gate check ─────────────────────────────────────────────────────────────

  /** Call at the start of each order's processing. Returns false = skip. */
  canProceed(): boolean {
    this.resetDailyIfNeeded();

    if (this.paused) {
      const remaining = this.pauseUntil - Date.now();
      if (remaining > 0) {
        logger.warn(`[risk] PAUSED — ${Math.ceil(remaining / 60_000)} min remaining (daily loss limit)`);
        return false;
      }
      // Pause expired
      this.paused = false;
      this.dailyLossUsd = 0;
      logger.info('[risk] Pause lifted — resuming fills');
    }

    if (this.activeFills >= CONFIG.MAX_CONCURRENT_FILLS) {
      logger.debug(`[risk] Concurrent fill cap reached (${this.activeFills}/${CONFIG.MAX_CONCURRENT_FILLS})`);
      return false;
    }

    return true;
  }

  /** Check if a token address is on the blacklist. */
  isTokenBlacklisted(token: string): boolean {
    return this.blacklist.has(token.toLowerCase());
  }

  // ── Concurrency tracking ────────────────────────────────────────────────────

  beginFill(): void  { this.activeFills++; }
  endFill():   void  { if (this.activeFills > 0) this.activeFills--; }
  activeFillCount(): number { return this.activeFills; }

  // ── Loss / profit accounting ────────────────────────────────────────────────

  recordLoss(amountUsd: number): void {
    this.dailyLossUsd += amountUsd;
    logger.warn(`[risk] Loss $${amountUsd.toFixed(4)} | daily total $${this.dailyLossUsd.toFixed(4)}`);

    if (this.dailyLossUsd >= CONFIG.DAILY_LOSS_LIMIT_USD) {
      this.paused     = true;
      this.pauseUntil = Date.now() + PAUSE_DURATION_MS;
      logger.error(
        `[risk] *** DAILY LOSS LIMIT $${CONFIG.DAILY_LOSS_LIMIT_USD} HIT *** — pausing 1 hour`,
      );
    }
  }

  recordProfit(amountUsd: number): void {
    // Profit does not offset daily loss counter (conservative)
    logger.debug(`[risk] Profit $${amountUsd.toFixed(4)}`);
  }

  // ── Daily reset ─────────────────────────────────────────────────────────────

  private resetDailyIfNeeded(): void {
    const today = todayUtcDate();
    if (today !== this.lastDayReset) {
      this.lastDayReset = today;
      this.dailyLossUsd = 0;
      logger.info('[risk] Daily loss counter reset (new UTC day)');
    }
  }

  // ── Status ──────────────────────────────────────────────────────────────────

  status(): Record<string, unknown> {
    return {
      paused:       this.paused,
      pauseUntil:   this.paused ? new Date(this.pauseUntil).toISOString() : null,
      dailyLossUsd: this.dailyLossUsd,
      activeFills:  this.activeFills,
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseBlacklist(): Set<string> {
  const raw = process.env.TOKEN_BLACKLIST ?? '';
  return new Set(raw.split(',').map(a => a.trim().toLowerCase()).filter(Boolean));
}

// ── Singleton export ──────────────────────────────────────────────────────────
export const riskGuard = new RiskGuard();
