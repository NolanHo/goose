#!/usr/bin/env node
/**
 * ACP Gateway — a proxy between ACP clients (Web/桌面) and goosed.
 *
 *   Client A (ws + permessage-deflate) ─┐
 *   Client B (ws + permessage-deflate) ─┼──→ Gateway (:39249) ──→ goosed (:39247)
 *                                       │     (1 upstream WS)      (persistent)
 *
 * Three capabilities goosed's ACP server doesn't provide:
 *
 * 1. **Compression** — downstream WS enables permessage-deflate.  ACP messages
 *    are JSON (~6% compression ratio); a 9 MB session replay drops to ~0.5 MB.
 *
 * 2. **Disconnect tolerance** — when a client disconnects the upstream WS to
 *    goosed stays open, so an in-flight prompt is NOT aborted.  On reconnect
 *    the client reloads the session; goosed replays from its database.
 *
 * 3. **Fan-out** — goosed messages are broadcast to every connected client.
 *
 * The gateway is stateless: it does not buffer messages, maintain session
 * state, or deduplicate.  Only `initialize` is intercepted (goosed accepts one
 * per WS connection); subsequent clients receive the cached response.
 *
 * Implementation note: the upstream WS uses Node's built-in global WebSocket
 * (undici), NOT the `ws` library.  The `ws` library's WSServer with
 * perMessageDeflate enabled interferes with same-process `ws` WebSocket clients
 * (on('message') never fires).  undici's WebSocket is unaffected.
 */

import { WebSocketServer } from 'ws';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config -----------------------------------------------------------------

function loadEnv() {
  try {
    for (const line of readFileSync(join(__dirname, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^VITE_(\w+)=(.*)$/);
      if (m) process.env[`VITE_${m[1]}`] = m[2].trim();
    }
  } catch {
    // .env is optional.
  }
}
loadEnv();

const GOOSED_HOST = process.env.VITE_GOOSE_ACP_HOST || 'localhost';
const GOOSED_PORT = process.env.VITE_GOOSE_ACP_PORT || '39247';
const TOKEN = process.env.VITE_GOOSE_TOKEN || '';
const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT || '39249', 10);

// --- State ------------------------------------------------------------------

/** Persistent upstream WS to goosed (undici WebSocket). */
let upstream = null;
let upstreamReady = false;
const upstreamQueue = [];          // messages buffered before upstream opens
let initResponse = null;           // cached { ...goosed init response }
/** Set of connected downstream clients (ws library). */
const clients = new Set();

// --- Upstream (goosed) ------------------------------------------------------

function connectUpstream() {
  if (upstream && (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)) {
    return;
  }

  const url = `ws://${GOOSED_HOST}:${GOOSED_PORT}/acp?token=${encodeURIComponent(TOKEN)}`;
  console.log(`[gateway] Connecting to goosed ${GOOSED_HOST}:${GOOSED_PORT} ...`);

  // Global WebSocket = undici (NOT ws library).  This is the fix for the
  // perMessageDeflate interference bug.
  upstream = new WebSocket(url);

  upstream.addEventListener('open', () => {
    upstreamReady = true;
    console.log('[gateway] goosed connected');
    for (const msg of upstreamQueue) upstream.send(msg);
    upstreamQueue.length = 0;
  });

  upstream.addEventListener('message', (event) => {
    const data = event.data; // string (ACP uses text frames)

    // Cache the first initialize response.
    if (!initResponse) {
      try {
        const msg = JSON.parse(data);
        if (msg.result && msg.result.protocolVersion !== undefined) {
          initResponse = msg;
          console.log('[gateway] Cached initialize response');
        }
      } catch { /* not JSON */ }
    }

    // Fan-out: forward to every connected client.
    for (const client of clients) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(data);
      }
    }
  });

  upstream.addEventListener('close', () => {
    console.log('[gateway] goosed disconnected, reconnecting in 1s');
    upstreamReady = false;
    upstream = null;
    initResponse = null;
    setTimeout(connectUpstream, 1000);
  });

  upstream.addEventListener('error', (event) => {
    // 'close' fires after error; log only.
    console.error('[gateway] upstream error:', event.message || event.type);
  });
}

function sendUpstream(data) {
  if (!upstream) connectUpstream();
  if (upstreamReady && upstream.readyState === WebSocket.OPEN) {
    upstream.send(data);
  } else {
    upstreamQueue.push(data);
  }
}

// --- Downstream (clients) ---------------------------------------------------

const wss = new WebSocketServer({
  port: GATEWAY_PORT,
  perMessageDeflate: {
    threshold: 1024,
    serverNoContextTakeover: true,
    clientNoContextTakeover: true,
  },
});

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`[gateway] Client connected (${clients.size} total)`);

  ws.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      // Not JSON-RPC — forward raw.
      sendUpstream(data.toString());
      return;
    }

    // Intercept initialize: goosed only accepts one per WS connection.
    // On reconnect, respond with the cached result.
    if (msg.method === 'initialize') {
      if (initResponse) {
        ws.send(JSON.stringify({ ...initResponse, id: msg.id }));
        return;
      }
      // First time — forward to goosed (response will be cached upstream).
    }

    sendUpstream(data.toString());
  });

  ws.on('close', () => {
    clients.delete(ws);
    console.log(`[gateway] Client disconnected (${clients.size} remaining) — upstream kept alive`);
  });

  ws.on('error', () => {
    clients.delete(ws);
  });
});

console.log(`[gateway] Listening on :${GATEWAY_PORT} (deflate) → goosed ${GOOSED_HOST}:${GOOSED_PORT}`);
