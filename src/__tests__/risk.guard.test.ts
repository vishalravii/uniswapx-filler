// Tests for the UniswapX filler RiskGuard singleton.
// We instantiate a fresh guard for each test by re-importing after jest.resetModules()
// to avoid cross-test state bleed, since the module exports a singleton.

// ── helpers ───────────────────────────────────────────────────────────────────

function freshGuard() {
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { riskGuard } = require('../risk/guard') as typeof import('../risk/guard');
  return riskGuard;
}

// ── canProceed ────────────────────────────────────────────────────────────────

describe('RiskGuard.canProceed', () => {
  test('fresh guard → can proceed', () => {
    const g = freshGuard();
    expect(g.canProceed()).toBe(true);
  });

  test('concurrent fill cap → returns false when cap reached', () => {
    const g = freshGuard();
    // Fill cap is driven by CONFIG.MAX_CONCURRENT_FILLS (default 3)
    g.beginFill();
    g.beginFill();
    g.beginFill();
    expect(g.canProceed()).toBe(false);
  });

  test('endFill releases one slot', () => {
    const g = freshGuard();
    g.beginFill();
    g.beginFill();
    g.beginFill();
    g.endFill();
    expect(g.canProceed()).toBe(true);
  });

  test('activeFillCount tracks correctly', () => {
    const g = freshGuard();
    expect(g.activeFillCount()).toBe(0);
    g.beginFill();
    g.beginFill();
    expect(g.activeFillCount()).toBe(2);
    g.endFill();
    expect(g.activeFillCount()).toBe(1);
  });

  test('endFill below zero is clamped to 0', () => {
    const g = freshGuard();
    g.endFill(); // no-op on empty counter
    expect(g.activeFillCount()).toBe(0);
  });
});

// ── daily loss limit ──────────────────────────────────────────────────────────

describe('RiskGuard daily loss limit', () => {
  test('loss below limit does not pause', () => {
    process.env.DAILY_LOSS_LIMIT_USD = '50';
    const g = freshGuard();
    g.recordLoss(10);
    expect(g.canProceed()).toBe(true);
  });

  test('loss at or above limit triggers pause', () => {
    process.env.DAILY_LOSS_LIMIT_USD = '50';
    const g = freshGuard();
    g.recordLoss(50);
    expect(g.canProceed()).toBe(false);
  });

  test('multiple small losses accumulate to limit', () => {
    process.env.DAILY_LOSS_LIMIT_USD = '50';
    const g = freshGuard();
    g.recordLoss(20);
    g.recordLoss(20);
    g.recordLoss(15); // total = 55 → over limit
    expect(g.canProceed()).toBe(false);
  });

  test('status reflects paused state', () => {
    process.env.DAILY_LOSS_LIMIT_USD = '50';
    const g = freshGuard();
    g.recordLoss(60);
    const s = g.status() as Record<string, unknown>;
    expect(s.paused).toBe(true);
    expect(typeof s.pauseUntil).toBe('string');
  });
});

// ── token blacklist ───────────────────────────────────────────────────────────

describe('RiskGuard.isTokenBlacklisted', () => {
  test('unknown token → false', () => {
    const g = freshGuard();
    expect(g.isTokenBlacklisted('0xabc')).toBe(false);
  });

  test('env TOKEN_BLACKLIST is loaded on startup', () => {
    process.env.TOKEN_BLACKLIST = '0xdeadtoken,0xbadtoken';
    const g = freshGuard();
    expect(g.isTokenBlacklisted('0xdeadtoken')).toBe(true);
    expect(g.isTokenBlacklisted('0xbadtoken')).toBe(true);
    expect(g.isTokenBlacklisted('0xgoodtoken')).toBe(false);
    delete process.env.TOKEN_BLACKLIST;
  });

  test('blacklist check is case-insensitive', () => {
    process.env.TOKEN_BLACKLIST = '0xDeAdToKeN';
    const g = freshGuard();
    expect(g.isTokenBlacklisted('0xdeadtoken')).toBe(true);
    expect(g.isTokenBlacklisted('0xDEADTOKEN')).toBe(true);
    delete process.env.TOKEN_BLACKLIST;
  });
});
