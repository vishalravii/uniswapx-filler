#!/usr/bin/env ts-node
// ============================================================
// scripts/shadow-test.ts — UniswapX shadow test runner
//
// Runs the full filler pipeline WITHOUT submitting any transactions.
// Requires only: RPC_URL_ARBITRUM + UNISWAP_API_KEY
//
// Usage:
//   npx ts-node -r dotenv/config scripts/shadow-test.ts
//   npx ts-node -r dotenv/config scripts/shadow-test.ts --duration=10  # minutes
//
// Output:
//   Console + reports/shadow-<date>.log
// ============================================================
import 'dotenv/config';
import { ethers }           from 'ethers';
import { mkdirSync, createWriteStream, WriteStream } from 'fs';
import { join }             from 'path';
import axios                from 'axios';

import { CONFIG }               from '../src/config';
import { getHttpProvider }      from '../src/chain/provider';
import { getGasParams }         from '../src/chain/gas';
import { calcProfitability }    from '../src/execution/profitability';
import { warmCache }            from '../src/quotes/quoter';
import { ApiOrder, ApiOrdersResponse, UniswapXOrder } from '../src/orders/types';
import { secsUntilExpiry, resolveInputAmount, resolveOutputAmount } from '../src/orders/decay';

// ── CLI args ──────────────────────────────────────────────────────────────────

const DURATION_MIN = (() => {
  const arg = process.argv.find(a => a.startsWith('--duration='));
  return arg ? parseInt(arg.split('=')[1], 10) : 5;
})();

const POLL_MS       = CONFIG.POLL_INTERVAL_MS;
const ZERO_ADDRESS  = '0x0000000000000000000000000000000000000000';
const REPORTS_DIR   = join(process.cwd(), 'reports');

// ── Report file ───────────────────────────────────────────────────────────────

mkdirSync(REPORTS_DIR, { recursive: true });
const reportFile = join(REPORTS_DIR, `shadow-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.log`);
const reportStream: WriteStream = createWriteStream(reportFile, { flags: 'a' });

function log(line: string): void {
  const ts  = new Date().toISOString();
  const out = `[${ts}] ${line}`;
  console.log(out);
  reportStream.write(out + '\n');
}

// ── Normalise raw order (same logic as watcher.ts) ───────────────────────────

function normalise(raw: ApiOrder): UniswapXOrder {
  const nowSecs = Math.floor(Date.now() / 1000);
  let decayStartTime: number, decayEndTime: number, exclusiveFiller: string;

  if (raw.type === 'Dutch_V2' && raw.cosignerData) {
    decayStartTime  = raw.cosignerData.decayStartTime;
    decayEndTime    = raw.cosignerData.decayEndTime;
    exclusiveFiller = raw.cosignerData.exclusiveFiller ?? ZERO_ADDRESS;
  } else {
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

// ── Fetch orders ──────────────────────────────────────────────────────────────

async function fetchOrders(): Promise<UniswapXOrder[]> {
  const params  = new URLSearchParams({
    chainId: String(CONFIG.CHAIN_ID),
    orderStatus: 'open',
    sortKey: 'createdAt',
    desc: 'true',
    limit: '50',
  });
  const url     = `${CONFIG.UNISWAPX_API}?${params}`;
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (CONFIG.UNISWAP_API_KEY) headers['x-api-key'] = CONFIG.UNISWAP_API_KEY;

  const resp = await axios.get<ApiOrdersResponse>(url, { timeout: 10_000, headers });
  const raw  = resp.data.orders ?? [];
  const nowSecs = Math.floor(Date.now() / 1000);

  return raw
    .filter(o =>
      o.orderStatus === 'open' &&
      o.chainId === CONFIG.CHAIN_ID &&
      o.deadline > nowSecs &&
      CONFIG.TRUSTED_REACTORS.has(o.reactor.toLowerCase()) &&
      o.encodedOrder && o.signature &&
      o.outputs && o.outputs.length > 0,
    )
    .map(normalise);
}

// ── Shadow statistics ─────────────────────────────────────────────────────────

interface ShadowStats {
  totalSeen:        number;
  totalQuoted:      number;
  totalProfitable:  number;
  skippedExpired:   number;
  skippedNoPool:    number;
  skippedNegSpread: number;
  skippedThinNet:   number;
  skippedUnknownToken: number;
  estGrossUsd:      number;
  estNetUsd:        number;
  latencies:        number[];
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  if (!process.env.RPC_URL_ARBITRUM) {
    console.error('❌  RPC_URL_ARBITRUM not set');
    process.exit(1);
  }
  if (!process.env.UNISWAP_API_KEY) {
    console.warn('⚠️  UNISWAP_API_KEY not set — requests will likely be rejected (403)');
    console.warn('   Get a free API key at https://developer.uniswap.org');
  }

  log(`══════════════════════════════════════════════════════════`);
  log(`  UniswapX Shadow Test — Arbitrum One`);
  log(`  Duration  : ${DURATION_MIN} min`);
  log(`  Poll rate : ${POLL_MS} ms`);
  log(`  Reactor   : ${[...CONFIG.TRUSTED_REACTORS].join(', ')}`);
  log(`  Report    : ${reportFile}`);
  log(`══════════════════════════════════════════════════════════`);

  // Warm the V3 quote cache immediately
  log('[init] Warming V3 quote cache…');
  await warmCache([
    [CONFIG.WETH,   CONFIG.USDC,   ethers.parseEther('0.1')],
    [CONFIG.USDC,   CONFIG.WETH,   100_000_000n],
    [CONFIG.WETH,   CONFIG.USDT,   ethers.parseEther('0.1')],
    [CONFIG.WETH,   CONFIG.USDC_E, ethers.parseEther('0.1')],
    [CONFIG.ARB,    CONFIG.USDC,   ethers.parseUnits('100', 18)],
    [CONFIG.WBTC,   CONFIG.USDC,   1_000_000n],
  ]).catch(() => {});
  log('[init] Cache warm complete. Starting shadow loop…\n');

  const stats: ShadowStats = {
    totalSeen: 0, totalQuoted: 0, totalProfitable: 0,
    skippedExpired: 0, skippedNoPool: 0, skippedNegSpread: 0,
    skippedThinNet: 0, skippedUnknownToken: 0,
    estGrossUsd: 0, estNetUsd: 0, latencies: [],
  };

  const seen    = new Set<string>();
  const endTime = Date.now() + DURATION_MIN * 60_000;
  let   pollNum = 0;
  let   apiErrors = 0;

  while (Date.now() < endTime) {
    pollNum++;
    const remaining = Math.ceil((endTime - Date.now()) / 1000);
    process.stdout.write(`\r  [poll ${pollNum}] ${remaining}s remaining | seen ${stats.totalSeen} | profitable ${stats.totalProfitable}  `);

    let orders: UniswapXOrder[];
    try {
      orders = await fetchOrders();
      apiErrors = 0;
    } catch (err: unknown) {
      apiErrors++;
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('403') || msg.includes('401')) {
        log(`\n[FATAL] API returned 403/401 — UNISWAP_API_KEY is missing or invalid.`);
        log(`        Register at https://developer.uniswap.org and add UNISWAP_API_KEY to .env`);
        process.exit(1);
      }
      log(`\n[WARN] Poll error #${apiErrors}: ${msg}`);
      await sleep(POLL_MS * 2);
      continue;
    }

    // Fetch gas params once per poll cycle
    let gasParams;
    try {
      gasParams = await getGasParams();
    } catch {
      log('\n[WARN] Gas spike — skipping this poll cycle');
      await sleep(POLL_MS);
      continue;
    }

    const newOrders = orders.filter(o => !seen.has(o.orderHash));
    for (const o of newOrders) seen.add(o.orderHash);
    stats.totalSeen += newOrders.length;

    // Process all new orders in parallel (shadow — no concurrency cap needed)
    await Promise.allSettled(newOrders.map(async (order) => {
      const t0 = Date.now();

      if (secsUntilExpiry(order) <= 3) { stats.skippedExpired++; return; }

      const result = await calcProfitability(order, gasParams);
      stats.totalQuoted++;

      if (!result.profitable) {
        const reason = result.reason ?? '';
        if (reason.includes('no V3 liquidity'))      stats.skippedNoPool++;
        else if (reason.includes('negative spread'))  stats.skippedNegSpread++;
        else if (reason.includes('net $'))            stats.skippedThinNet++;
        else if (reason.includes('unknown output'))   stats.skippedUnknownToken++;
        return;
      }

      stats.totalProfitable++;
      stats.estGrossUsd += result.grossProfitUsd;
      stats.estNetUsd   += result.netProfitUsd;
      stats.latencies.push(Date.now() - t0);

      const nowSecs      = Math.floor(Date.now() / 1000);
      const inputAmt     = resolveInputAmount(order, nowSecs);
      const outputAmt    = resolveOutputAmount(order, 0, nowSecs);
      const quoteOut     = result.quote?.amountOut ?? 0n;
      const spreadRaw    = quoteOut > outputAmt ? quoteOut - outputAmt : 0n;

      log(
        `\n[WOULD FILL] ${order.orderHash.slice(0, 18)}…` +
        `\n  type        : ${order.type}` +
        `\n  sell        : ${inputAmt.toString().slice(0,12)} of ${order.input.token}` +
        `\n  buy (limit) : ${outputAmt.toString().slice(0,12)} of ${order.outputs[0].token}` +
        `\n  quote out   : ${quoteOut.toString().slice(0,12)}` +
        `\n  spread raw  : ${spreadRaw.toString().slice(0,12)}` +
        `\n  gross $     : $${result.grossProfitUsd.toFixed(4)}` +
        `\n  gas  $      : $${result.gasCostUsd.toFixed(4)}` +
        `\n  net  $      : $${result.netProfitUsd.toFixed(4)}` +
        `\n  quote path  : ${result.quote?.isMultiHop ? '2-hop via WETH' : `single-hop fee=${result.quote?.fee ?? '?'}`}` +
        `\n  latency     : ${Date.now() - order.discoveredAtMs} ms`,
      );
    }));

    await sleep(POLL_MS);
  }

  // ── Final summary ─────────────────────────────────────────────────────────
  const latSorted = [...stats.latencies].sort((a, b) => a - b);
  const p50 = percentile(latSorted, 50);
  const p95 = percentile(latSorted, 95);

  const durationActual = DURATION_MIN;
  const ordersPerMin   = stats.totalSeen / durationActual;
  const fillsPerMin    = stats.totalProfitable / durationActual;
  const netPerMin      = stats.estNetUsd / durationActual;

  log(`\n\n══════════════════════════════════════════════════════════`);
  log(`  SHADOW TEST RESULTS  (${DURATION_MIN} min)`);
  log(`══════════════════════════════════════════════════════════`);
  log(`  Orders seen        : ${stats.totalSeen}  (${ordersPerMin.toFixed(1)}/min)`);
  log(`  Orders quoted      : ${stats.totalQuoted}`);
  log(`  Profitable         : ${stats.totalProfitable}  (${fillsPerMin.toFixed(2)}/min)`);
  log(`  ── Skip reasons ──────────────────────────────────────`);
  log(`    No V3 pool       : ${stats.skippedNoPool}`);
  log(`    Negative spread  : ${stats.skippedNegSpread}`);
  log(`    Net too thin     : ${stats.skippedThinNet}`);
  log(`    Unknown token    : ${stats.skippedUnknownToken}`);
  log(`    Expired          : ${stats.skippedExpired}`);
  log(`  ── Profit estimate ───────────────────────────────────`);
  log(`  Est. gross profit  : $${stats.estGrossUsd.toFixed(4)}`);
  log(`  Est. net profit    : $${stats.estNetUsd.toFixed(4)}`);
  log(`  ── Projected daily ───────────────────────────────────`);
  log(`  Net $/day (extrap) : $${(netPerMin * 60 * 24).toFixed(2)}`);
  log(`  Fills/day          : ${Math.round(fillsPerMin * 60 * 24)}`);
  log(`  ── Latency (quote only) ──────────────────────────────`);
  log(`  p50                : ${p50} ms`);
  log(`  p95                : ${p95} ms`);
  log(`══════════════════════════════════════════════════════════`);
  log(`  Full report saved to: ${reportFile}`);
  log(`══════════════════════════════════════════════════════════\n`);

  reportStream.end();
  process.exit(0);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

function percentile(sorted: number[], pct: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.floor(sorted.length * pct / 100);
  return sorted[Math.min(idx, sorted.length - 1)];
}

// ── Boot ──────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('[shadow-test] Fatal error:', err);
  process.exit(1);
});
