// ============================================================
// Uniswap V3 multi-hop quoter with in-memory cache
//
// Strategy (fastest → most accurate):
//   1. Check cache (TTL = 8 s, ~4 Arb blocks).
//   2. Try SINGLE-HOP across all 4 fee tiers in parallel.
//   3. If no direct pool, try TWO-HOP via WETH as intermediary
//      (covers exotic → WETH → output pairs).
//   4. Return the best amountOut found.
//
// All calls are eth_call (staticCall) — no gas spent on quotes.
// Timeout is applied per call group to bound total latency.
// ============================================================
import { ethers }          from 'ethers';
import { getHttpProvider } from '../chain/provider';
import { CONFIG }          from '../config';
import { logger }          from '../utils/logger';

// ── ABI ──────────────────────────────────────────────────────────────────────

const QUOTER_ABI = [
  // Single-hop
  'function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) external returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)',
  // Multi-hop
  'function quoteExactInput(bytes path, uint256 amountIn) external returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)',
] as const;

const FEE_TIERS = [100, 500, 3000, 10000] as const; // 0.01% 0.05% 0.30% 1.00%

// ── Types ─────────────────────────────────────────────────────────────────────

export interface QuoteResult {
  amountOut:   bigint;
  gasEstimate: bigint;
  fee?:        number;   // winning fee tier (single-hop) or undefined (multi-hop)
  isMultiHop?: boolean;
}

interface CacheEntry {
  result: QuoteResult;
  ts:     number;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

const cache = new Map<string, CacheEntry>();

function cacheKey(tokenIn: string, tokenOut: string, amountIn: bigint): string {
  return `${tokenIn.toLowerCase()}|${tokenOut.toLowerCase()}|${amountIn.toString()}`;
}

function cached(key: string): QuoteResult | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CONFIG.QUOTE_TTL_MS) { cache.delete(key); return null; }
  return entry.result;
}

function store(key: string, result: QuoteResult): void {
  // Keep cache bounded — evict oldest entries when over 500 entries
  if (cache.size >= 500) {
    const oldest = [...cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    if (oldest) cache.delete(oldest[0]);
  }
  cache.set(key, { result, ts: Date.now() });
}

// ── Path encoding (ABI packed) ────────────────────────────────────────────────

/**
 * Encode a Uniswap V3 multi-hop path: [token0, fee01, token1, fee12, token2].
 * Format: 0x{token0_40hex}{fee01_6hex}{token1_40hex}{fee12_6hex}{token2_40hex}
 */
function encodePath(tokens: string[], fees: number[]): string {
  if (tokens.length !== fees.length + 1) throw new Error('encodePath: tokens.length must equal fees.length + 1');
  let hex = tokens[0].slice(2).toLowerCase();
  for (let i = 0; i < fees.length; i++) {
    hex += fees[i].toString(16).padStart(6, '0');
    hex += tokens[i + 1].slice(2).toLowerCase();
  }
  return '0x' + hex;
}

// ── Quoter contract instance (lazy-singleton) ─────────────────────────────────

let quoterInstance: ethers.Contract | null = null;

function getQuoter(): ethers.Contract {
  if (!quoterInstance) {
    quoterInstance = new ethers.Contract(CONFIG.QUOTER_V2, QUOTER_ABI, getHttpProvider());
  }
  return quoterInstance;
}

// ── Quote helpers ─────────────────────────────────────────────────────────────

/** Single-hop: try all fee tiers in parallel, return best amountOut. */
async function singleHopBest(
  tokenIn:  string,
  tokenOut: string,
  amountIn: bigint,
): Promise<QuoteResult | null> {
  const quoter = getQuoter();
  const queries = FEE_TIERS.map(fee =>
    quoter.quoteExactInputSingle.staticCall(
      { tokenIn, tokenOut, amountIn, fee, sqrtPriceLimitX96: 0n },
      { blockTag: 'latest' },
    )
      .then((r: [bigint, bigint, number, bigint]) => ({ fee, amountOut: r[0], gasEstimate: r[3] }))
      .catch(() => null),
  );

  const results = await Promise.all(queries);
  return results.reduce<QuoteResult | null>((best, r) => {
    if (!r) return best;
    if (!best || r.amountOut > best.amountOut) {
      return { amountOut: r.amountOut, gasEstimate: r.gasEstimate, fee: r.fee };
    }
    return best;
  }, null);
}

/**
 * Two-hop via WETH intermediary: tokenIn → WETH → tokenOut.
 * Tries all fee-tier combinations (4×4 = 16) but only the two most
 * common combinations to keep latency low: [500,500] and [3000,500].
 */
async function twoHopViaWeth(
  tokenIn:  string,
  tokenOut: string,
  amountIn: bigint,
): Promise<QuoteResult | null> {
  const weth    = CONFIG.WETH;
  const quoter  = getQuoter();

  // Skip if one of the tokens IS WETH — single-hop is already optimal
  if (tokenIn.toLowerCase()  === weth) return null;
  if (tokenOut.toLowerCase() === weth) return null;

  const feePairs: [number, number][] = [[500, 500], [3000, 500], [500, 3000], [3000, 3000]];

  const queries = feePairs.map(([f1, f2]) => {
    const path = encodePath([tokenIn, weth, tokenOut], [f1, f2]);
    return quoter.quoteExactInput.staticCall(path, amountIn, { blockTag: 'latest' })
      .then((r: [bigint, bigint[], number[], bigint]) => ({
        amountOut:   r[0],
        gasEstimate: r[3],
      }))
      .catch(() => null);
  });

  const results = await Promise.all(queries);
  return results.reduce<QuoteResult | null>((best, r) => {
    if (!r) return best;
    if (!best || r.amountOut > best.amountOut) {
      return { amountOut: r.amountOut, gasEstimate: r.gasEstimate, isMultiHop: true };
    }
    return best;
  }, null);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Get the best Uniswap V3 quote for tokenIn → tokenOut swapping amountIn.
 * Returns null if no liquidity is found on any path.
 *
 * Caches results for QUOTE_TTL_MS to avoid redundant RPC calls when
 * multiple orders have the same token pair.
 */
export async function getBestQuote(
  tokenIn:  string,
  tokenOut: string,
  amountIn: bigint,
): Promise<QuoteResult | null> {
  const key = cacheKey(tokenIn, tokenOut, amountIn);
  const hit = cached(key);
  if (hit) return hit;

  const timeout = new Promise<null>(resolve =>
    setTimeout(() => resolve(null), CONFIG.QUOTE_TIMEOUT_MS),
  );

  const work = (async (): Promise<QuoteResult | null> => {
    // Run single-hop and two-hop in parallel
    const [single, twoHop] = await Promise.all([
      singleHopBest(tokenIn, tokenOut, amountIn).catch(() => null),
      twoHopViaWeth(tokenIn, tokenOut, amountIn).catch(() => null),
    ]);

    const best: QuoteResult | null = [single, twoHop].reduce<QuoteResult | null>((b, r) => {
      if (!r) return b;
      if (!b || r.amountOut > b.amountOut) return r;
      return b;
    }, null);

    if (best) store(key, best);
    return best;
  })();

  const result = await Promise.race([work, timeout]);
  if (!result) {
    logger.debug(`[quoter] Timeout quoting ${tokenIn.slice(0, 10)}→${tokenOut.slice(0, 10)}`);
  }
  return result;
}

/** Warm the cache for a list of high-frequency token pairs. Call on each new block. */
export async function warmCache(pairs: Array<[string, string, bigint]>): Promise<void> {
  await Promise.allSettled(
    pairs.map(([tokenIn, tokenOut, amountIn]) => getBestQuote(tokenIn, tokenOut, amountIn)),
  );
}
