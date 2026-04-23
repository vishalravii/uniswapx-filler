// ============================================================
// RPC provider management
//
// Strategy:
//   • One HTTP provider  — used for staticCalls (quotes, balance checks)
//   • One WS  provider  — used for block subscriptions and fill submissions
//     WS reconnects automatically on drop; HTTP is stateless (no reconnect needed).
//
// Keeping two providers avoids the case where a quota-limited WS connection
// also slows down our quote path.
// ============================================================
import { ethers } from 'ethers';
import { CONFIG }  from '../config';
import { logger }  from '../utils/logger';

// ── HTTP provider (quote calls, balance checks) ───────────────────────────────

let _http: ethers.JsonRpcProvider | null = null;

export function getHttpProvider(): ethers.JsonRpcProvider {
  if (!_http) {
    _http = new ethers.JsonRpcProvider(CONFIG.RPC_HTTP_URL, CONFIG.CHAIN_ID, {
      staticNetwork: ethers.Network.from(CONFIG.CHAIN_ID),
    });
  }
  return _http;
}

// ── WebSocket provider (block listener, tx submission) ───────────────────────

let _ws: ethers.WebSocketProvider | null = null;
let _wsReconnectTimer: NodeJS.Timeout | null = null;
let _reconnectAttempts = 0;
const MAX_RECONNECT_DELAY_MS = 30_000;

type WsReadyCallback = (provider: ethers.WebSocketProvider) => void;
const _wsReadyCallbacks: WsReadyCallback[] = [];

function connectWs(): void {
  const url = CONFIG.RPC_WS_URL;
  if (!url) {
    logger.warn('[provider] RPC_WS_URL_ARBITRUM not set — WebSocket features disabled');
    return;
  }

  logger.info(`[provider] Connecting WebSocket RPC…`);

  const ws = new ethers.WebSocketProvider(url, CONFIG.CHAIN_ID);

  // ethers v6 WebSocketProvider emits these events on the underlying socket
  ws.on('network', () => {
    _ws = ws;
    _reconnectAttempts = 0;
    logger.info('[provider] WebSocket RPC connected');
    _wsReadyCallbacks.forEach(cb => cb(ws));
  });

  // Detect disconnect by listening on the raw websocket (typed as unknown)
  const rawWs = ws.websocket as unknown as {
    onclose?: (ev: { code: number }) => void;
    onerror?: (ev: unknown) => void;
  };

  rawWs.onclose = (ev: { code: number }) => {
    _ws = null;
    logger.warn(`[provider] WebSocket closed (code=${ev.code}) — scheduling reconnect`);
    scheduleReconnect();
  };

  rawWs.onerror = (ev: unknown) => {
    logger.error('[provider] WebSocket error', ev);
  };
}

function scheduleReconnect(): void {
  if (_wsReconnectTimer) return;
  _reconnectAttempts++;
  const delay = Math.min(1_000 * Math.pow(2, _reconnectAttempts), MAX_RECONNECT_DELAY_MS);
  logger.info(`[provider] WebSocket reconnect in ${(delay / 1000).toFixed(1)}s (attempt ${_reconnectAttempts})`);
  _wsReconnectTimer = setTimeout(() => {
    _wsReconnectTimer = null;
    connectWs();
  }, delay);
}

/** Returns current WS provider or null if not yet connected. */
export function getWsProvider(): ethers.WebSocketProvider | null {
  return _ws;
}

/** Subscribe to be called when a WS provider is (re-)connected. */
export function onWsReady(cb: WsReadyCallback): void {
  _wsReadyCallbacks.push(cb);
  if (_ws) cb(_ws); // fire immediately if already connected
}

/** Initialise WebSocket connection. Call once at startup. */
export function initWsProvider(): void {
  if (CONFIG.RPC_WS_URL) connectWs();
}

// ── Submission provider ───────────────────────────────────────────────────────
// For tx submission we prefer Flashbots Protect (avoids sandwich attacks).
// Falls back to HTTP RPC if FLASHBOTS_RPC is not configured.

let _submit: ethers.JsonRpcProvider | null = null;

export function getSubmitProvider(): ethers.JsonRpcProvider {
  if (!_submit) {
    const url = CONFIG.FLASHBOTS_RPC || CONFIG.RPC_HTTP_URL;
    _submit = new ethers.JsonRpcProvider(url, CONFIG.CHAIN_ID, {
      staticNetwork: ethers.Network.from(CONFIG.CHAIN_ID),
    });
    if (CONFIG.FLASHBOTS_RPC) {
      logger.info('[provider] Using Flashbots Protect for tx submission');
    }
  }
  return _submit;
}
