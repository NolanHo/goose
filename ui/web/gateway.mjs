#!/usr/bin/env node
/**
 * ACP Client Gateway
 *
 *   Browser (ws+deflate) ─┐                          ┌─ ClientSideConnection (ACP client, persistent)
 *   Browser (ws+deflate) ─┼──→ Gateway (:39249) ─────┤   upstream WS → goosed (:39247, ?token=)
 *                         │   AgentSideConnection   │   (undici global WebSocket)
 *                         │   (ACP server, per-browser) │
 *                         └──────────────────────────┘
 *
 * Why this exists: ACP binds prompt execution to the WS connection. When the
 * browser disconnects, goosed's Connection::shutdown() aborts the in-flight
 * prompt. This gateway holds the prompt lifecycle itself — the browser's
 * prompt call is forwarded to the gateway's OWN upstream client.prompt(),
 * which keeps running regardless of whether any browser is connected.
 *
 * Architecture:
 *  - Upstream: ONE persistent ClientSideConnection to goosed (undici WebSocket,
 *    start-mode stream). Holds prompt lifecycles; survives browser disconnect.
 *  - Downstream: one AgentSideConnection per browser (ws library + deflate).
 *    The Agent implementation forwards every method to the upstream client.
 *  - Routing: goosed's session/update notifications + permission/elicitation
 *    requests are routed to browsers subscribed to that session. Notifications
 *    are also buffered so a reconnecting browser can replay recent activity
 *    before loadSession replays the full history.
 *
 * Upstream uses undici's global WebSocket (NOT the `ws` library) to avoid a
 * conflict where `ws` WSServer (downstream, perMessageDeflate) silences
 * on('message') for in-process `ws` WebSocket clients.
 */

import wsPkg from '/vePFS-Mindverse/user/nolanho/code/goose/ui/node_modules/ws/index.js';
const { WebSocketServer } = wsPkg;
import { createServer, get as httpGet } from 'http';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  ClientSideConnection,
  AgentSideConnection,
} from '/vePFS-Mindverse/user/nolanho/code/goose/ui/node_modules/@agentclientprotocol/sdk/dist/acp.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// --- Config -----------------------------------------------------------------

function loadEnv() {
  try {
    for (const line of readFileSync(join(__dirname, '.env'), 'utf8').split('\n')) {
      const m = line.match(/^VITE_(\w+)=(.*)$/);
      if (m) process.env[`VITE_${m[1]}`] = m[2].trim();
    }
  } catch {
    /* .env is optional */
  }
}
loadEnv();

const GOOSED_HOST = process.env.VITE_GOOSE_ACP_HOST || 'localhost';
const GOOSED_PORT = process.env.VITE_GOOSE_ACP_PORT || '39247';
const TOKEN = process.env.VITE_GOOSE_TOKEN || '';

// httpGet is imported from 'http' at the top of the file.
const GATEWAY_PORT = parseInt(process.env.GATEWAY_PORT || '39249', 10);
const BUFFER_LIMIT = 500; // max notifications buffered per session

// --- Stream adapters --------------------------------------------------------
// Both adapters use the `start(controller)` pattern (matching the SDK's own
// tests) — push messages via controller.enqueue, close/error via the controller.

/**
 * Upstream stream: undici global WebSocket → ACP Stream.
 * goosed's /acp speaks text-frame JSON-RPC; undici returns string for text.
 */
function createUpstreamStream(url) {
  const ws = new WebSocket(url);
  let rc;
  ws.addEventListener('message', (e) => {
    if (typeof e.data !== 'string') return;
    try { rc?.enqueue(JSON.parse(e.data)); } catch { /* malformed */ }
  });
  ws.addEventListener('close', () => { try { rc?.close(); } catch {} });
  ws.addEventListener('error', () => { try { rc?.error(new Error('upstream ws')); } catch {} });

  const openPromise = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', () => reject(new Error('upstream open failed')), { once: true });
    ws.addEventListener('close', () => reject(new Error('upstream closed pre-open')), { once: true });
  });

  const readable = new ReadableStream({ start(c) { rc = c; } });
  const writable = new WritableStream({
    async write(msg) {
      await openPromise;
      if (ws.readyState !== 1) throw new Error('upstream not open');
      ws.send(JSON.stringify(msg));
    },
  });
  return { readable, writable, ws, close: () => ws.close() };
}

/**
 * Downstream stream: ws-library WebSocket (from WSServer) → ACP Stream.
 * perMessageDeflate is handled by the WSServer; messages arrive as Buffer.
 */
function createDownstreamStream(ws) {
  let rc;
  ws.on('message', (data) => {
    try { rc?.enqueue(JSON.parse(data.toString())); } catch { /* malformed */ }
  });
  ws.on('close', () => { try { rc?.close(); } catch {} });
  ws.on('error', () => { try { rc?.error(new Error('downstream ws')); } catch {} });

  const readable = new ReadableStream({ start(c) { rc = c; } });
  const writable = new WritableStream({
    write(msg) { ws.send(JSON.stringify(msg)); },
  });
  return { readable, writable };
}

// --- Upstream (gateway → goosed) -------------------------------------------

let upstream = null;            // ClientSideConnection
let upstreamStream = null;      // { readable, writable, ws, close }
let upstreamReady = false;
let cachedInit = null;          // cached InitializeResponse

// session-id → set of downstream connections subscribed to that session
const subscribers = new Map();
// session-id → array of buffered session/update notifications (for replay)
const buffers = new Map();

function subscribe(sessionId, conn) {
  let set = subscribers.get(sessionId);
  if (!set) { set = new Set(); subscribers.set(sessionId, set); }
  set.add(conn);
}
function unsubscribeAll(conn) {
  for (const [sid, set] of subscribers) {
    set.delete(conn);
    if (set.size === 0) subscribers.delete(sid);
  }
}

/** Buffer a notification for a session (capped). */
function bufferNotification(sessionId, notification) {
  let buf = buffers.get(sessionId);
  if (!buf) { buf = []; buffers.set(sessionId, buf); }
  buf.push(notification);
  if (buf.length > BUFFER_LIMIT) buf.splice(0, buf.length - BUFFER_LIMIT);
}

/** Forward a goosed notification to all browsers subscribed to a session. */
function routeNotification(sessionId, method, params) {
  const subs = subscribers.get(sessionId);
  // Buffer only when no live subscriber exists (the disconnect-window case
  // the buffer is for). Otherwise goosed's own loadSession replay already
  // delivers the history — buffering would duplicate it.
  if (!subs || subs.size === 0) {
    bufferNotification(sessionId, { method, params });
    return;
  }
  for (const conn of subs) {
    if (conn._closed) continue;
    if (method === 'session/update') conn._agent.sessionUpdate(params);
    else conn._agent.extNotification(method, params);
  }
}

/**
 * Route a goosed→client RPC request (permission/elicitation) to the browser
 * subscribed to the session, and await its response. If no browser is online,
 * return 'cancelled' so the agent isn't blocked forever.
 */
async function routeRequest(sessionId, fn) {
  const subs = subscribers.get(sessionId);
  if (!subs) return { outcome: { outcome: 'cancelled' } };
  for (const conn of subs) {
    if (conn._closed) continue;
    try {
      return await fn(conn._agent);
    } catch {
      // Browser disconnected mid-RPC — treat like "no browser" (cancelled).
      return { outcome: { outcome: 'cancelled' } };
    }
  }
  return { outcome: { outcome: 'cancelled' } };
}

function connectUpstream() {
  if (!TOKEN) console.warn('[gateway] WARNING: VITE_GOOSE_TOKEN is empty — upstream will 401');
  if (upstream && upstreamReady) return;

  const url = `ws://${GOOSED_HOST}:${GOOSED_PORT}/acp?token=${encodeURIComponent(TOKEN)}`;
  console.log(`[gateway] Connecting to goosed ${GOOSED_HOST}:${GOOSED_PORT} ...`);
  upstreamStream = createUpstreamStream(url);

  const callbacks = () => ({
    // goosed → client: callbacks receive *params* directly (not a notification
    // wrapper). Each carries sessionId for routing to subscribed browsers.
    sessionUpdate(params) {
      const sid = params?.sessionId;
      if (sid) routeNotification(sid, 'session/update', params);
    },
    // Goose extensions: the raw ClientSideConnection dispatches unknown methods
    // to extMethod/extNotification (default branch). Route goose-specific ones
    // to their named callbacks; mirror GooseClient's dispatchers.
    extNotification(method, params) {
      if (method === '_goose/unstable/session/update') {
        const sid = params?.sessionId;
        if (sid) routeNotification(sid, method, params);
      }
    },
    extMethod(method, params) {
      if (method === '_goose/unstable/session/recipe/request-params') {
        return routeRequest(params?.sessionId, (agent) =>
          agent.extMethod(method, params)
        );
      }
      throw new Error(`unhandled ext method: ${method}`);
    },
    // goosed → client requests (await browser response, or cancel if offline)
    requestPermission(params) {
      return routeRequest(params?.sessionId, (agent) => agent.requestPermission(params));
    },
    unstable_createElicitation(params) {
      return routeRequest(params?.sessionId, (agent) => agent.unstable_createElicitation(params));
    },
  });

  upstream = new ClientSideConnection(callbacks, upstreamStream);
  upstreamReady = true;
  console.log('[gateway] upstream connected');

  // B2: reconnect when the upstream WS drops (goosed restart, network blip).
  upstreamStream.ws.addEventListener('close', () => {
    if (!upstreamReady) return; // already reconnecting
    console.log('[gateway] upstream disconnected, reconnecting in 1s');
    upstreamReady = false;
    upstream = null;
    cachedInit = null; // must re-initialize on the new connection
    upstreamStream = null;
    setTimeout(connectUpstream, 1000);
  });
}

// --- Downstream Agent (per browser) ----------------------------------------

function createDownstreamAgent(conn) {
  // Every method forwards to the persistent upstream client. The upstream
  // WS stays open independently of this browser connection, so an in-flight
  // prompt keeps running even after the browser disconnects.
  const fwd = (method) => (params) => {
    if (!upstream) throw new Error('upstream not connected');
    return upstream[method](params);
  };

  return {
    // initialize: goosed accepts one per WS connection. Cache + reuse.
    initialize: async (params) => {
      if (!cachedInit) cachedInit = await upstream.initialize(params);
      return cachedInit;
    },
    newSession: async (params) => {
      const res = await upstream.newSession(params);
      subscribe(res.sessionId, conn);
      return res;
    },
    loadSession: async (params) => {
      subscribe(params.sessionId, conn);
      const res = await upstream.loadSession(params);
      // goosed's loadSession replays the full conversation history itself.
      // Clear our buffer — it was only for the disconnect window, and
      // replaying it now would duplicate goosed's authoritative replay.
      buffers.delete(params.sessionId);
      return res;
    },
    // THE CORE: prompt is forwarded to the gateway's own upstream client.
    // The await lives in this process — browser disconnect does NOT abort it.
    prompt: fwd('prompt'),
    cancel: fwd('cancel'),
    listSessions: fwd('listSessions'),
    unstable_forkSession: fwd('unstable_forkSession'),
    unstable_closeSession: fwd('unstable_closeSession'),
    unstable_resumeSession: fwd('unstable_resumeSession'),
    unstable_setSessionModel: fwd('unstable_setSessionModel'),
    setSessionMode: fwd('setSessionMode'),
    setSessionConfigOption: fwd('setSessionConfigOption'),
    authenticate: fwd('authenticate'),
    unstable_logout: fwd('unstable_logout'),
    // goose extensions + any unknown method → forward generically
    extMethod: (method, params) => upstream.extMethod(method, params),
    extNotification: (method, params) => upstream.extNotification(method, params),
  };
}

// --- Downstream server (browser → gateway) ----------------------------------

// HTTP layer: forward /health and /status to goosed so the frontend only
// needs to know one address (the gateway). Other paths return 404.
const httpServer = createServer((req, res) => {
  const path = req.url?.split('?')[0];
  if (path === '/health' || path === '/status') {
    const proxyReq = httpGet(`http://${GOOSED_HOST}:${GOOSED_PORT}${path}`, (upRes) => {
      res.writeHead(upRes.statusCode || 200, upRes.headers);
      upRes.pipe(res);
    });
    proxyReq.on('error', () => {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'goosed unreachable' }));
    });
  } else {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }
});

const wss = new WebSocketServer({
  server: httpServer,
  perMessageDeflate: { threshold: 1024, serverNoContextTakeover: true, clientNoContextTakeover: true },
});

wss.on('connection', (ws) => {
  const stream = createDownstreamStream(ws);
  const conn = { _closed: false };
  const agent = createDownstreamAgent(conn);
  conn._agent = new AgentSideConnection(() => agent, stream);

  ws.on('close', () => {
    conn._closed = true;
    unsubscribeAll(conn);
    console.log(`[gateway] browser disconnected (subscribers: ${subscribers.size} sessions)`);
  });
  ws.on('error', () => { conn._closed = true; });

  console.log('[gateway] browser connected');
});

wss.on('listening', () => {
  connectUpstream();
  console.log(`[gateway] Listening on :${GATEWAY_PORT} (HTTP + WS deflate) → goosed ${GOOSED_HOST}:${GOOSED_PORT}`);
});

httpServer.listen(GATEWAY_PORT);
