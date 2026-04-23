// ============================================================
// UniswapX API order types
//
// Source: https://api.uniswap.org/v2/dutch-auction/orders
// Compatible with Dutch (V1 ExclusiveDutch) and Dutch_V2 order types.
// ============================================================

export type OrderStatus = 'open' | 'filled' | 'cancelled' | 'expired' | 'error' | 'insufficient-funds';
export type OrderType   = 'Dutch_V2' | 'Dutch' | 'Limit' | 'Priority';

export interface ApiOrderInput {
  token:       string;
  startAmount: string; // bigint string
  endAmount:   string; // bigint string — equals startAmount when input is fixed
}

export interface ApiOrderOutput {
  token:       string;
  startAmount: string; // bigint string — highest amount (start of auction)
  endAmount:   string; // bigint string — lowest  amount (end of auction)
  recipient:   string; // where filler sends output tokens (usually the swapper)
}

/** Co-signer data attached by Uniswap's backend for Dutch_V2 orders */
export interface ApiCosignerData {
  decayStartTime:  number;   // unix seconds
  decayEndTime:    number;   // unix seconds
  exclusiveFiller: string;   // address("0x00…") when no exclusivity
  inputOverride:   string;   // "0" when no override
  outputOverrides: string[]; // parallel to outputs[], "0" when no override
}

/** Raw order as returned by the UniswapX Orders API */
export interface ApiOrder {
  orderHash:   string;
  signature:   string;   // user EIP-712 signature (passed to reactor as `sig`)
  encodedOrder:string;   // ABI-encoded order bytes (passed to reactor as `order`)
  chainId:     number;
  orderStatus: OrderStatus;
  type:        OrderType;
  swapper:     string;
  reactor:     string;   // which reactor contract handles this order
  deadline:    number;   // unix seconds — hard expiry

  // ── Decoded fields (populated by API, saves us from decoding encodedOrder) ──
  input:   ApiOrderInput;
  outputs: ApiOrderOutput[];

  // Dutch V1 timing (top-level, not in cosignerData)
  decayStartTime?:         number;
  decayEndTime?:           number;
  exclusiveFiller?:        string;
  exclusivityOverrideBps?: number;

  // Dutch V2 timing (nested inside cosignerData)
  cosignerData?: ApiCosignerData;
  cosignature?:  string;
}

export interface ApiOrdersResponse {
  orders:  ApiOrder[];
  cursor?: string;
}

// ── Internal resolved order ───────────────────────────────────────────────────

/**
 * Normalised order with timing fields promoted to the top level.
 * Created by the watcher from raw ApiOrder so the rest of the pipeline
 * never needs to branch on V1/V2.
 */
export interface UniswapXOrder extends ApiOrder {
  /** Decay starts at this unix timestamp (seconds). Price is best for filler before this. */
  resolvedDecayStartTime:  number;
  /** Decay ends (order deadline) at this unix timestamp (seconds). */
  resolvedDecayEndTime:    number;
  /** Zero address when there is no exclusivity restriction. */
  resolvedExclusiveFiller: string;
  /** Wall-clock ms when this order was first observed by our watcher. */
  discoveredAtMs:          number;
}
