// ============================================================
// UniswapX Filler — main entry point
//
// Startup sequence:
//   1. Validate config / env vars.
//   2. Initialise providers, signer, nonce manager.
//   3. Pre-approve common output tokens on the reactor.
//   4. Start block-level cache warmer (WS or polling).
//   5. Start order watcher — emits 'order' events.
//   6. For each order: profitability check → risk check → fill.
//   7. Hourly summary log.
//   8. Graceful shutdown on SIGTERM/SIGINT.
// ============================================================
import 'dotenv/config';
import { ethers }             from 'ethers';

import { CONFIG }             from './config';
import { logger }             from './utils/logger';
import { initWsProvider, getHttpProvider, onWsReady } from './chain/provider';
import { NonceManager }       from './chain/nonce';
import { getGasParams }       from './chain/gas';
import { OrderWatcher }       from './orders/watcher';
import { UniswapXOrder }      from './orders/types';
import { isExclusivityActive, msUntilExclusivityEnds, secsUntilExpiry } from './orders/decay';
import { calcProfitability }  from './execution/profitability';
import { ensureApprovals }    from './execution/approvals';
import { fillOrder }          from './execution/filler';
import { riskGuard }          from './risk/guard';
import { metrics }            from './monitoring/metrics';
import { warmCache }          from './quotes/quoter';

// ── Startup ───────────────────────────────────────────────────────────────────

const SHADOW_MODE = process.env.SHADOW_MODE === 'true';

async function main(): Promise<void> {
  logger.info('═══════════════════════════════════════════════════');
  logger.info('  UniswapX Filler Starting — Arbitrum One');
  if (SHADOW_MODE) logger.info('  *** SHADOW MODE — no transactions will be submitted ***');
  logger.info(`  Chain ID    : ${CONFIG.CHAIN_ID}`);
  logger.info(`  Reactors    : ${[...CONFIG.TRUSTED_REACTORS].join(', ')}`);
  logger.info(`  Min profit  : $${CONFIG.MIN_PROFIT_USD}`);
  logger.info(`  Max gas     : ${CONFIG.MAX_GAS_GWEI} gwei`);
  logger.info(`  Max fills   : ${CONFIG.MAX_CONCURRENT_FILLS}`);
  logger.info('═══════════════════════════════════════════════════');

  // ── 1. Validate essential config ────────────────────────────────────────
  if (!process.env.RPC_URL_ARBITRUM) throw new Error('RPC_URL_ARBITRUM not set');
  if (!SHADOW_MODE && !process.env.FILLER_PRIVATE_KEY) throw new Error('FILLER_PRIVATE_KEY not set');
  if (!process.env.UNISWAP_API_KEY)  logger.warn('[startup] UNISWAP_API_KEY not set — API may reject requests (get one at developer.uniswap.org)');

  // ── 2. Initialise signer + nonce manager ────────────────────────────────
  const httpProvider = getHttpProvider();

  // In shadow mode we use a random throwaway wallet — no real key needed
  // ethers v6: createRandom() returns HDNodeWallet; cast to Wallet for type compat
  const signer: ethers.Wallet = SHADOW_MODE
    ? (ethers.Wallet.createRandom().connect(httpProvider) as unknown as ethers.Wallet)
    : new ethers.Wallet(CONFIG.PRIVATE_KEY, httpProvider);
  const nonceManager = new NonceManager(signer.address, httpProvider);

  if (!SHADOW_MODE) {
    logger.info(`  Filler wallet: ${signer.address}`);
    const ethBalance = await httpProvider.getBalance(signer.address);
    logger.info(`  ETH balance  : ${ethers.formatEther(ethBalance)} ETH`);
    if (ethBalance < ethers.parseEther('0.005')) {
      logger.warn('[startup] Low ETH balance — may run out of gas for fills!');
    }
    await nonceManager.init();
  } else {
    logger.info('  [shadow] Wallet: ephemeral (no keys loaded)');
  }

  // ── 3. Initialise WebSocket provider ────────────────────────────────────
  initWsProvider();

  // ── 4. Pre-approve common output tokens on all trusted reactors ──────────
  if (!SHADOW_MODE) {
    const commonOutputTokens = [
      CONFIG.USDC, CONFIG.USDC_E, CONFIG.USDT, CONFIG.DAI, CONFIG.WETH,
    ];
    for (const reactorAddr of CONFIG.TRUSTED_REACTORS) {
      await ensureApprovals(signer, commonOutputTokens, reactorAddr);
    }
  } else {
    logger.info('[startup] Shadow mode — skipping token approvals');
  }

  // ── 5. Block-level cache warmer ──────────────────────────────────────────
  // Warm V3 price cache on every new block so common-pair quotes
  // are always fresh when an order arrives.
  const warmPairs: Array<[string, string, bigint]> = [
    [CONFIG.WETH,   CONFIG.USDC,   ethers.parseEther('0.1')],
    [CONFIG.USDC,   CONFIG.WETH,   100_000_000n],    // 100 USDC
    [CONFIG.WETH,   CONFIG.USDT,   ethers.parseEther('0.1')],
    [CONFIG.WETH,   CONFIG.USDC_E, ethers.parseEther('0.1')],
    [CONFIG.ARB,    CONFIG.USDC,   ethers.parseUnits('100', 18)],
    [CONFIG.WBTC,   CONFIG.USDC,   1_000_000n],       // 0.01 WBTC
  ];

  onWsReady((wsProv) => {
    wsProv.on('block', () => {
      void warmCache(warmPairs).catch(() => { /* silent */ });
    });
    logger.info('[main] Block-level cache warmer active via WebSocket');
  });

  // Fallback: warm via polling if WS not available
  if (!CONFIG.RPC_WS_URL) {
    setInterval(() => void warmCache(warmPairs).catch(() => {}), 2_000);
    logger.info('[main] Block-level cache warmer active via polling (no WS configured)');
  }

  // ── 6. Order processing ──────────────────────────────────────────────────
  const watcher = new OrderWatcher();
  const pending  = new Set<string>(); // orderHash of in-flight fills

  watcher.on('order', (order: UniswapXOrder) => {
    void processOrder(order, signer, nonceManager, pending);
  });

  watcher.start();

  // ── 7. Hourly summary ────────────────────────────────────────────────────
  setInterval(() => metrics.dailySummary(), 60 * 60 * 1_000);

  // ── 8. Graceful shutdown ─────────────────────────────────────────────────
  const shutdown = (signal: string) => {
    logger.info(`[main] ${signal} received — shutting down`);
    watcher.stop();
    metrics.dailySummary();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));

  logger.info('[main] Filler running. Waiting for orders…\n');
}

// ── Order processing pipeline ─────────────────────────────────────────────────

async function processOrder(
  order:        UniswapXOrder,
  signer:       ethers.Wallet,
  nonceManager: NonceManager,
  pending:      Set<string>,
): Promise<void> {
  const hash = order.orderHash;

  // Dedup: skip if already filling this order
  if (pending.has(hash)) return;

  // ── Expiry guard ──────────────────────────────────────────────────────────
  if (secsUntilExpiry(order) <= 5) return;

  // ── Token blacklist ───────────────────────────────────────────────────────
  const outputToken = order.outputs[0]?.token;
  if (!outputToken) return;
  if (riskGuard.isTokenBlacklisted(order.input.token) || riskGuard.isTokenBlacklisted(outputToken)) {
    logger.debug(`[main] Blacklisted token in order ${hash.slice(0, 12)}`);
    return;
  }

  // ── Exclusivity: schedule for when window ends ────────────────────────────
  const exclusivityMs = msUntilExclusivityEnds(order);
  if (isExclusivityActive(order, signer.address)) {
    if (exclusivityMs > 0 && exclusivityMs < 30_000) {
      // Schedule fill attempt after exclusivity ends (within 30 s)
      logger.debug(`[main] Scheduling fill in ${exclusivityMs} ms after exclusivity expires`);
      setTimeout(() => void processOrder(order, signer, nonceManager, pending), exclusivityMs + 100);
    }
    // Else exclusivity window is too long — not worth waiting
    return;
  }

  // ── Risk gate ─────────────────────────────────────────────────────────────
  if (!riskGuard.canProceed()) return;

  // ── Profitability check ───────────────────────────────────────────────────
  let gasParams;
  try {
    gasParams = await getGasParams();
  } catch (err) {
    logger.warn(`[main] Gas spike — skipping order`, err);
    return;
  }

  const profitResult = await calcProfitability(order, gasParams);

  if (!profitResult.profitable) {
    logger.debug(`[main] Not profitable ${hash.slice(0, 12)}: ${profitResult.reason}`);
    return;
  }

  // ── Shadow mode: log and stop — no tx submitted ───────────────────────────
  if (SHADOW_MODE) {
    logger.info(
      `[SHADOW] WOULD FILL ${hash.slice(0, 16)}…  ` +
      `in=${order.input.token.slice(0, 10)} → out=${order.outputs[0].token.slice(0, 10)}  ` +
      `gross=$${profitResult.grossProfitUsd.toFixed(4)}  ` +
      `gas=$${profitResult.gasCostUsd.toFixed(4)}  ` +
      `net=$${profitResult.netProfitUsd.toFixed(4)}`,
    );
    metrics.recordFill({ netProfitUsd: profitResult.netProfitUsd, latencyMs: Date.now() - order.discoveredAtMs, gasUsedUsd: profitResult.gasCostUsd });
    return;
  }

  // ── Execute fill ─────────────────────────────────────────────────────────
  pending.add(hash);
  riskGuard.beginFill();

  try {
    const outcome = await fillOrder(order, profitResult, signer, nonceManager);

    if (outcome.success) {
      riskGuard.recordProfit(outcome.netProfitUsd);
    } else {
      logger.warn(`[main] Fill failed ${hash.slice(0, 12)}: ${outcome.reason}`);
      if (outcome.gasUsedUsd) riskGuard.recordLoss(outcome.gasUsedUsd);
    }
  } finally {
    pending.delete(hash);
    riskGuard.endFill();
  }
}

// ── Boot ──────────────────────────────────────────────────────────────────────

main().catch(err => {
  logger.error('[main] Fatal startup error', err);
  process.exit(1);
});
