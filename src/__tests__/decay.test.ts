import {
  linearDecay,
  resolveInputAmount,
  resolveOutputAmount,
  isExclusivityActive,
  msUntilExclusivityEnds,
  secsUntilExpiry,
} from '../orders/decay';
import type { UniswapXOrder } from '../orders/types';

// ── helpers ───────────────────────────────────────────────────────────────────

const ZERO = '0x0000000000000000000000000000000000000000';
const FILLER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1';
const OTHER  = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

function nowSecs() { return Math.floor(Date.now() / 1000); }

function makeOrder(overrides: Partial<UniswapXOrder> = {}): UniswapXOrder {
  const now = nowSecs();
  return {
    orderHash:                '0xdeadbeef',
    chainId:                  42161,
    type:                     'Dutch_V2',
    orderStatus:              'open',
    swapper:                  '0x1234',
    reactor:                  '0x1bd1aAdc9E230626C44a139d7E70d842749351eb',
    deadline:                 now + 300,
    input: { token: '0xinput',  startAmount: '1000000000000000000', endAmount: '1000000000000000000' },
    outputs: [{ token: '0xoutput', startAmount: '2000000000', endAmount: '1900000000', recipient: ZERO }],
    resolvedDecayStartTime:   now - 10,
    resolvedDecayEndTime:     now + 20,
    resolvedExclusiveFiller:  ZERO,
    discoveredAtMs:           Date.now(),
    encodedOrder:             '0x',
    signature:                '0x',
    ...overrides,
  };
}

// ── linearDecay ───────────────────────────────────────────────────────────────

describe('linearDecay', () => {
  test('before decay starts → returns startAmount', () => {
    expect(linearDecay(1000n, 500n, 100, 200, 90)).toBe(1000n);
  });

  test('after decay ends → returns endAmount', () => {
    expect(linearDecay(1000n, 500n, 100, 200, 210)).toBe(500n);
  });

  test('exactly at decayStartTime → returns startAmount', () => {
    expect(linearDecay(1000n, 500n, 100, 200, 100)).toBe(1000n);
  });

  test('exactly at decayEndTime → returns endAmount', () => {
    expect(linearDecay(1000n, 500n, 100, 200, 200)).toBe(500n);
  });

  test('downward decay: midpoint → halfway between start and end', () => {
    const result = linearDecay(1000n, 0n, 0, 100, 50);
    expect(result).toBe(500n);
  });

  test('upward decay (input expanding): midpoint', () => {
    const result = linearDecay(0n, 1000n, 0, 100, 50);
    expect(result).toBe(500n);
  });

  test('decayStartTime === decayEndTime → returns endAmount', () => {
    expect(linearDecay(1000n, 500n, 50, 50, 50)).toBe(500n);
  });

  test('75% through → correct interpolation', () => {
    // 1000 → 0 over 100s, at t=75 → 250
    expect(linearDecay(1000n, 0n, 0, 100, 75)).toBe(250n);
  });

  test('large bigint values remain accurate', () => {
    const start = 10n ** 18n;
    const end   = 0n;
    // At t=1 out of 1000 → should lose 1/1000 of start
    const result = linearDecay(start, end, 0, 1000, 1);
    expect(result).toBe(start - start / 1000n);
  });
});

// ── resolveInputAmount ────────────────────────────────────────────────────────

describe('resolveInputAmount', () => {
  test('cosignerData inputOverride takes priority', () => {
    const order = makeOrder({
      input: { token: '0xinput', startAmount: '999', endAmount: '999' },
      cosignerData: {
        decayStartTime:   0,
        decayEndTime:     0,
        exclusiveFiller:  ZERO,
        inputOverride:    '12345678',
        outputOverrides:  [],
      },
    });
    expect(resolveInputAmount(order, 0)).toBe(12345678n);
  });

  test('inputOverride = "0" is ignored, falls through to linearDecay', () => {
    const now = nowSecs();
    const order = makeOrder({
      input: { token: '0xinput', startAmount: '1000', endAmount: '1000' },
      resolvedDecayStartTime: now - 100,
      resolvedDecayEndTime:   now + 100,
      cosignerData: {
        decayStartTime:  0,
        decayEndTime:    0,
        exclusiveFiller: ZERO,
        inputOverride:   '0',
        outputOverrides: [],
      },
    });
    expect(resolveInputAmount(order, now)).toBe(1000n);
  });

  test('before decay → returns startAmount', () => {
    const now = nowSecs();
    const order = makeOrder({
      input: { token: '0xinput', startAmount: '2000', endAmount: '1000' },
      resolvedDecayStartTime: now + 100,
      resolvedDecayEndTime:   now + 200,
    });
    expect(resolveInputAmount(order, now)).toBe(2000n);
  });
});

// ── resolveOutputAmount ───────────────────────────────────────────────────────

describe('resolveOutputAmount', () => {
  test('throws RangeError for out-of-range index', () => {
    const order = makeOrder();
    expect(() => resolveOutputAmount(order, 5, nowSecs())).toThrow(RangeError);
  });

  test('outputOverride takes priority when non-zero', () => {
    const order = makeOrder({
      cosignerData: {
        decayStartTime:  0,
        decayEndTime:    0,
        exclusiveFiller: ZERO,
        inputOverride:   '0',
        outputOverrides: ['99999999'],
      },
    });
    expect(resolveOutputAmount(order, 0, nowSecs())).toBe(99999999n);
  });

  test('outputOverride = "0" falls through to linearDecay', () => {
    const now = nowSecs();
    const order = makeOrder({
      outputs: [{ token: '0xout', startAmount: '5000', endAmount: '5000', recipient: ZERO }],
      resolvedDecayStartTime: now + 100,
      resolvedDecayEndTime:   now + 200,
      cosignerData: {
        decayStartTime:  0,
        decayEndTime:    0,
        exclusiveFiller: ZERO,
        inputOverride:   '0',
        outputOverrides: ['0'],
      },
    });
    expect(resolveOutputAmount(order, 0, now)).toBe(5000n);
  });

  test('after decay end → returns endAmount', () => {
    const now = nowSecs();
    const order = makeOrder({
      outputs: [{ token: '0xout', startAmount: '1000', endAmount: '500', recipient: ZERO }],
      resolvedDecayStartTime: now - 200,
      resolvedDecayEndTime:   now - 100,
    });
    expect(resolveOutputAmount(order, 0, now)).toBe(500n);
  });
});

// ── isExclusivityActive ───────────────────────────────────────────────────────

describe('isExclusivityActive', () => {
  test('no exclusive filler (zero address) → false', () => {
    const order = makeOrder({ resolvedExclusiveFiller: ZERO, resolvedDecayStartTime: nowSecs() + 100 });
    expect(isExclusivityActive(order, OTHER)).toBe(false);
  });

  test('we ARE the exclusive filler → false (we can fill)', () => {
    const order = makeOrder({ resolvedExclusiveFiller: FILLER, resolvedDecayStartTime: nowSecs() + 100 });
    expect(isExclusivityActive(order, FILLER)).toBe(false);
  });

  test('case-insensitive address match → false', () => {
    const order = makeOrder({
      resolvedExclusiveFiller: FILLER.toUpperCase(),
      resolvedDecayStartTime:  nowSecs() + 100,
    });
    expect(isExclusivityActive(order, FILLER.toLowerCase())).toBe(false);
  });

  test('different filler, window active → true (blocked)', () => {
    const order = makeOrder({ resolvedExclusiveFiller: FILLER, resolvedDecayStartTime: nowSecs() + 100 });
    expect(isExclusivityActive(order, OTHER)).toBe(true);
  });

  test('different filler, window already passed → false', () => {
    const order = makeOrder({ resolvedExclusiveFiller: FILLER, resolvedDecayStartTime: nowSecs() - 5 });
    expect(isExclusivityActive(order, OTHER)).toBe(false);
  });
});

// ── msUntilExclusivityEnds ────────────────────────────────────────────────────

describe('msUntilExclusivityEnds', () => {
  test('zero address → 0', () => {
    const order = makeOrder({ resolvedExclusiveFiller: ZERO });
    expect(msUntilExclusivityEnds(order)).toBe(0);
  });

  test('window already passed → 0', () => {
    const order = makeOrder({ resolvedExclusiveFiller: FILLER, resolvedDecayStartTime: nowSecs() - 60 });
    expect(msUntilExclusivityEnds(order)).toBe(0);
  });

  test('future window → positive number ≤ duration', () => {
    const order = makeOrder({ resolvedExclusiveFiller: FILLER, resolvedDecayStartTime: nowSecs() + 10 });
    const ms = msUntilExclusivityEnds(order);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(11_000);
  });
});

// ── secsUntilExpiry ───────────────────────────────────────────────────────────

describe('secsUntilExpiry', () => {
  test('order with 5 min deadline → ~300s', () => {
    const order = makeOrder({ deadline: nowSecs() + 300 });
    const secs = secsUntilExpiry(order);
    expect(secs).toBeGreaterThan(295);
    expect(secs).toBeLessThanOrEqual(300);
  });

  test('expired order → negative', () => {
    const order = makeOrder({ deadline: nowSecs() - 60 });
    expect(secsUntilExpiry(order)).toBeLessThan(0);
  });
});
