// ============================================================
// Central configuration — all constants in one place.
// Never hard-code secrets; use .env for private keys / RPC URLs.
// ============================================================
import 'dotenv/config';

// ── Helpers ──────────────────────────────────────────────────────────────────

function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Required env var ${key} is not set. See .env.example`);
  return v;
}

function parseTrustedReactors(): Set<string> {
  const raw = process.env.TRUSTED_REACTORS ?? '0x1bd1aAdc9E230626C44a139d7E70d842749351eb';
  return new Set(raw.split(',').map(a => a.trim().toLowerCase()).filter(Boolean));
}

// ── Exported config ───────────────────────────────────────────────────────────

export const CONFIG = {
  // ── Chain ──────────────────────────────────────────────────
  CHAIN_ID: 42161 as const,

  // ── Trusted reactor addresses (Arbitrum One) ───────────────
  // ExclusiveDutchOrderReactor V1 — verified on Arbiscan:
  //   https://arbiscan.io/address/0x1bd1aAdc9E230626C44a139d7E70d842749351eb
  // Add additional reactor addresses to TRUSTED_REACTORS env var (comma-separated).
  TRUSTED_REACTORS: parseTrustedReactors(),

  // ── Uniswap V3 contracts (same address Mainnet & Arbitrum) ─
  QUOTER_V2:    '0x61fFE014bA17989E743c5F6cB21bF9697530B21e',
  SWAP_ROUTER:  '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',

  // ── Token registry — Arbitrum One (all lower-case) ────────
  WETH:   '0x82af49447d8a07e3bd95bd0d56f35241523fbab1',
  USDC:   '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
  USDC_E: '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8',
  USDT:   '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9',
  DAI:    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1',
  ARB:    '0x912ce59144191c1204e64559fe8253a0e49e6548',
  WBTC:   '0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f',

  // Stablecoins — used for USD-shortcut price conversion (6 decimals)
  STABLECOINS: new Set<string>([
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
    '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', // USDC.e
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // USDT
    '0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', // DAI (18 dec — handled separately)
  ]),

  // Token decimals — avoids on-chain calls on the hot path
  TOKEN_DECIMALS: new Map<string, number>([
    ['0x82af49447d8a07e3bd95bd0d56f35241523fbab1', 18], // WETH
    ['0xaf88d065e77c8cc2239327c5edb3a432268e5831', 6 ], // USDC
    ['0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', 6 ], // USDC.e
    ['0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', 6 ], // USDT
    ['0xda10009cbd5d07dd0cecc66161fc93d7c9000da1', 18], // DAI
    ['0x912ce59144191c1204e64559fe8253a0e49e6548', 18], // ARB
    ['0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f', 8 ], // WBTC
  ]),

  // ── UniswapX Orders API ─────────────────────────────────────
  // v2 endpoint requires x-api-key header (get from developer.uniswap.org)
  UNISWAPX_API:     'https://api.uniswap.org/v2/dutch-auction/orders',
  get UNISWAP_API_KEY() { return process.env.UNISWAP_API_KEY ?? ''; },
  POLL_INTERVAL_MS: 1_500,  // 1.5 s — roughly every 3 Arbitrum blocks

  // ── Quoting ─────────────────────────────────────────────────
  QUOTE_TTL_MS:     8_000,  // cache quote for ~4 Arbitrum blocks
  QUOTE_TIMEOUT_MS: 3_000,  // abort staticCall after 3 s

  // ── Profitability ───────────────────────────────────────────
  MIN_PROFIT_USD:   parseFloat(process.env.MIN_PROFIT_USD ?? '0.10'),
  GAS_LIMIT_FILL:   400_000n, // conservative upper bound for a V3-sourced fill
  ETH_PRICE_TTL_MS: 30_000,

  // ── Risk ────────────────────────────────────────────────────
  DAILY_LOSS_LIMIT_USD:  parseFloat(process.env.DAILY_LOSS_LIMIT_USD  ?? '50'),
  MAX_CONCURRENT_FILLS:  parseInt(process.env.MAX_CONCURRENT_FILLS    ?? '3', 10),
  MAX_GAS_GWEI:          parseFloat(process.env.MAX_GAS_GWEI           ?? '2'),

  // ── RPC / wallet ────────────────────────────────────────────
  get RPC_HTTP_URL()    { return requireEnv('RPC_URL_ARBITRUM'); },
  get RPC_WS_URL()      { return process.env.RPC_WS_URL_ARBITRUM ?? ''; },
  get PRIVATE_KEY()     { return requireEnv('FILLER_PRIVATE_KEY'); },
  get FLASHBOTS_RPC()   { return process.env.FLASHBOTS_RPC ?? ''; },
} as const;
