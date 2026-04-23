// ============================================================
// In-process metrics tracker
//
// Tracks fills, profit, latency, and race losses.
// Prints a rolling summary every hour to the log.
// ============================================================
import { logger } from '../utils/logger';

interface FillRecord {
  netProfitUsd: number;
  latencyMs:    number;
  gasUsedUsd:   number;
}

class Metrics {
  private fills:     FillRecord[] = [];
  private raceLosts  = 0;
  private lossTotal  = 0;
  private sessionStart = Date.now();
  private lastSummary  = Date.now();

  private readonly SUMMARY_INTERVAL_MS = 60 * 60 * 1_000; // 1 hour

  recordFill(r: FillRecord): void {
    this.fills.push(r);
    this.maybePrintSummary();
  }

  recordRaceLost(): void {
    this.raceLosts++;
  }

  recordLoss(usd: number): void {
    this.lossTotal += usd;
  }

  dailySummary(): void {
    const now = Date.now();
    const uptimeMins = ((now - this.sessionStart) / 60_000).toFixed(1);

    const totalFills    = this.fills.length;
    const totalProfit   = this.fills.reduce((s, f) => s + f.netProfitUsd, 0);
    const totalGas      = this.fills.reduce((s, f) => s + f.gasUsedUsd, 0);
    const latencies     = this.fills.map(f => f.latencyMs).sort((a, b) => a - b);
    const p50           = percentile(latencies, 50);
    const p95           = percentile(latencies, 95);

    logger.info('══════════════════════════════════════');
    logger.info(`  Filler session summary (uptime ${uptimeMins} min)`);
    logger.info(`  Fills:       ${totalFills}`);
    logger.info(`  Net profit:  $${totalProfit.toFixed(4)}`);
    logger.info(`  Gas spent:   $${totalGas.toFixed(4)}`);
    logger.info(`  Losses:      $${this.lossTotal.toFixed(4)}`);
    logger.info(`  Race-losts:  ${this.raceLosts}`);
    logger.info(`  Latency p50: ${p50} ms`);
    logger.info(`  Latency p95: ${p95} ms`);
    logger.info('══════════════════════════════════════');
  }

  private maybePrintSummary(): void {
    if (Date.now() - this.lastSummary >= this.SUMMARY_INTERVAL_MS) {
      this.lastSummary = Date.now();
      this.dailySummary();
    }
  }
}

function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(sorted.length * pct / 100);
  return sorted[Math.min(idx, sorted.length - 1)];
}

export const metrics = new Metrics();
