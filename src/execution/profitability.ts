// ============================================================
// Profitability calculator
//
// Core formula:
//   gross_profit_in_output_token
//     = market_quote(inputToken → outputToken, inputAmount)
//     - resolved_output_amount
//
//   net_profit_usd = gross_profit_usd - gas_cost_usd
//
// We express everything in output-token units first, then convert to
// USD using price shortcuts (stable = $1/token, WETH = ethPriceUsd).
// For exotic tokens we fall back to a zero-profit result (skip the order).
// ============================================================
import { CONFIG }                                from '../config';
import { UniswapXOrder }                         from '../orders/types';
import { resolveInputAmount, resolveOutputAmount } from '../orders/decay';
import { getBestQuote, QuoteResult }             from '../quotes/quoter';
import { estimateGasCostUsd, GasParams }         from '../chain/gas';
import { logger }                                from '../utils/logger';

// ── ETH price cache ────────────────────────────────────────────────────────────

let cachedEthPriceUsd = 2_400;
let ethPriceFetchedAt = 0;

async function getEthPriceUsd(): Promise<number> {
  if (Date.now() - ethPriceFetchedAt < CONFIG.ETH_PRICE_TTL_MS) return cachedEthPriceUsd;
  try {
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd';
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    const json = await res.json() as { ethereum?: { usd?: number } };
    const price = json?.ethereum?.usd;
    if (price && price > 100) {
      cachedEthPriceUsd = price;
      ethPriceFetchedAt = Date.now();
    }
  } catch { /* use stale value */ }
  return cachedEthPriceUsd;
}

// ── USD conversion helpers ────────────────────────────────────────────────────

/**
 * Convert an amount of `token` (in raw uint256 units) to USD.
 * Returns null if the token price is unknown.
 */
function rawToUsd(
  amount:      bigint,
  token:       string,
  ethPriceUsd: number,
): number | null {
  const lower = token.toLowerCase();

  // Stablecoins with 6 decimals — USDC, USDC.e, USDT
  if (
    lower === CONFIG.USDC   ||
    lower === CONFIG.USDC_E ||
    lower === CONFIG.USDT
  ) {
    return Number(amount) / 1e6;
  }

  // DAI — 18 decimals, ≈ $1
  if (lower === CONFIG.DAI) return Number(amount) / 1e18;

  // WETH — 18 decimals
  if (lower === CONFIG.WETH) return (Number(amount) / 1e18) * ethPriceUsd;

  // WBTC — 8 decimals; approximate using BTC ≈ 15× ETH (rough)
  if (lower === CONFIG.WBTC) return (Number(amount) / 1e8) * ethPriceUsd * 15;

  // Unknown token — we cannot price it
  return null;
}

// ── Public result type ────────────────────────────────────────────────────────

export interface ProfitabilityResult {
  profitable:           boolean;
  netProfitUsd:         number;
  grossProfitUsd:       number;
  gasCostUsd:           number;
  resolvedInputAmount:  bigint;
  resolvedOutputAmount: bigint;
  quote:                QuoteResult | null;
  reason?:              string;  // why it's not profitable
}

const NOT_PROFITABLE = (reason: string): ProfitabilityResult => ({
  profitable: false, netProfitUsd: 0, grossProfitUsd: 0, gasCostUsd: 0,
  resolvedInputAmount: 0n, resolvedOutputAmount: 0n, quote: null, reason,
});

// ── Main function ─────────────────────────────────────────────────────────────

export async function calcProfitability(
  order:      UniswapXOrder,
  gasParams:  GasParams,
): Promise<ProfitabilityResult> {
  // Only handle single-output orders for now (covers >95% of UniswapX volume)
  if (order.outputs.length !== 1) {
    return NOT_PROFITABLE(`multi-output order (${order.outputs.length} outputs)`);
  }

  const nowSecs = Math.floor(Date.now() / 1000);

  const resolvedInputAmount  = resolveInputAmount(order, nowSecs);
  const resolvedOutputAmount = resolveOutputAmount(order, 0, nowSecs);

  const inputToken  = order.input.token.toLowerCase();
  const outputToken = order.outputs[0].token.toLowerCase();

  // ── Quote: how much outputToken do we get from selling inputToken on V3 ──
  const quote = await getBestQuote(inputToken, outputToken, resolvedInputAmount);

  if (!quote) {
    return NOT_PROFITABLE('no V3 liquidity found');
  }

  // ── Profit in output token units ─────────────────────────────────────────
  const spreadInOutput = quote.amountOut - resolvedOutputAmount;
  if (spreadInOutput <= 0n) {
    return NOT_PROFITABLE(`negative spread (market=${quote.amountOut} < limit=${resolvedOutputAmount})`);
  }

  const ethPriceUsd = await getEthPriceUsd();

  // ── Convert spread → USD ──────────────────────────────────────────────────
  const grossProfitUsd = rawToUsd(spreadInOutput, outputToken, ethPriceUsd);

  if (grossProfitUsd === null) {
    // We can still fill but can't estimate profit — skip to be safe
    return NOT_PROFITABLE(`unknown output token price (${outputToken})`);
  }

  // ── Gas cost ──────────────────────────────────────────────────────────────
  const gasLimit    = quote.isMultiHop ? CONFIG.GAS_LIMIT_FILL : CONFIG.GAS_LIMIT_FILL * 3n / 4n;
  const gasCostUsd  = estimateGasCostUsd(gasLimit, gasParams, ethPriceUsd);
  const netProfitUsd = grossProfitUsd - gasCostUsd;

  if (netProfitUsd < CONFIG.MIN_PROFIT_USD) {
    return {
      profitable: false, netProfitUsd, grossProfitUsd, gasCostUsd,
      resolvedInputAmount, resolvedOutputAmount, quote,
      reason: `net $${netProfitUsd.toFixed(4)} < min $${CONFIG.MIN_PROFIT_USD}`,
    };
  }

  logger.debug(
    `[profit] ${order.orderHash.slice(0, 12)}… ` +
    `gross=$${grossProfitUsd.toFixed(4)} gas=$${gasCostUsd.toFixed(4)} net=$${netProfitUsd.toFixed(4)}`,
  );

  return { profitable: true, netProfitUsd, grossProfitUsd, gasCostUsd, resolvedInputAmount, resolvedOutputAmount, quote };
}
