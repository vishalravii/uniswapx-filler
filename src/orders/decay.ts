// ============================================================
// Dutch-auction decay mathematics
//
// UniswapX Dutch orders decay linearly over [decayStartTime, decayEndTime]:
//   • Input  can stay fixed (V2 typical) or increase (filler receives more over time)
//   • Output decreases over time (filler provides less as auction progresses)
//
// As a filler, waiting = lower output cost = higher profit.
// But waiting also means more competition and possible expiry.
// ============================================================
import { UniswapXOrder } from './types';

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Linear interpolation between startAmount and endAmount.
 * If startAmount > endAmount (typical for outputs) this decays downward.
 * If startAmount < endAmount (possible for inputs) this increases.
 */
export function linearDecay(
  startAmount:    bigint,
  endAmount:      bigint,
  decayStartTime: number,
  decayEndTime:   number,
  nowSecs:        number,
): bigint {
  if (nowSecs <= decayStartTime) return startAmount;
  if (nowSecs >= decayEndTime)   return endAmount;
  if (decayEndTime === decayStartTime) return endAmount;

  const elapsed  = BigInt(nowSecs - decayStartTime);
  const duration = BigInt(decayEndTime - decayStartTime);

  if (startAmount >= endAmount) {
    // Downward decay (outputs)
    const diff = startAmount - endAmount;
    return startAmount - (diff * elapsed / duration);
  } else {
    // Upward decay (inputs expanding)
    const diff = endAmount - startAmount;
    return startAmount + (diff * elapsed / duration);
  }
}

/** Resolved input amount at time `nowSecs` (what filler will receive). */
export function resolveInputAmount(order: UniswapXOrder, nowSecs: number): bigint {
  // V2 cosignerData may override the input amount completely
  const override = order.cosignerData?.inputOverride;
  if (override && override !== '0') return BigInt(override);

  return linearDecay(
    BigInt(order.input.startAmount),
    BigInt(order.input.endAmount),
    order.resolvedDecayStartTime,
    order.resolvedDecayEndTime,
    nowSecs,
  );
}

/** Resolved output[idx] amount at time `nowSecs` (what filler must provide). */
export function resolveOutputAmount(order: UniswapXOrder, outputIdx: number, nowSecs: number): bigint {
  const out = order.outputs[outputIdx];
  if (!out) throw new RangeError(`resolveOutputAmount: index ${outputIdx} out of range`);

  // V2 cosignerData may override individual output amounts
  const override = order.cosignerData?.outputOverrides?.[outputIdx];
  if (override && override !== '0') return BigInt(override);

  return linearDecay(
    BigInt(out.startAmount),
    BigInt(out.endAmount),
    order.resolvedDecayStartTime,
    order.resolvedDecayEndTime,
    nowSecs,
  );
}

/**
 * Returns true when we are NOT the exclusive filler and the exclusivity
 * window is still active — we must wait before filling.
 */
export function isExclusivityActive(order: UniswapXOrder, ourAddress: string): boolean {
  const exclusive = order.resolvedExclusiveFiller;
  if (!exclusive || exclusive === ZERO_ADDRESS) return false;
  if (exclusive.toLowerCase() === ourAddress.toLowerCase()) return false;
  return Math.floor(Date.now() / 1000) < order.resolvedDecayStartTime;
}

/** Milliseconds until the exclusivity window ends (0 if already ended or no exclusivity). */
export function msUntilExclusivityEnds(order: UniswapXOrder): number {
  if (order.resolvedExclusiveFiller === ZERO_ADDRESS) return 0;
  const nowMs  = Date.now();
  const endMs  = order.resolvedDecayStartTime * 1000;
  return Math.max(0, endMs - nowMs);
}

/** Seconds remaining before this order expires. */
export function secsUntilExpiry(order: UniswapXOrder): number {
  return order.deadline - Math.floor(Date.now() / 1000);
}
