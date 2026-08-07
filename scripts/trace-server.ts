/**
 * Phase 3 — Live Trace Server
 *
 * HTTP + WebSocket server on port 4300.
 * Runs TaskExecutor with an ExecutorBus and broadcasts every event to all
 * connected WebSocket clients in real time.
 *
 * Routes:
 *   GET  /api/graph    → TASK_GRAPH as JSON
 *   GET  /api/health   → provider health
 *   POST /api/run      → start a new executor run
 *   POST /api/approve  → approve budget overspend { delta: number }
 *   POST /api/reject   → reject budget overspend
 *   WS   /ws           → real-time event stream (broadcasts WsEvent frames)
 */

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { startAllProviders, stopAllProviders, ServerHandle } from "./start-providers.js";
import { Ledger } from "../src/ledger/ledger.js";
import { SimulatedWallet } from "../src/wallet/wallet.js";
import { Treasury } from "../src/treasury/treasury.js";
import { TaskExecutor } from "../src/engine/executor.js";
import { ExecutorBus } from "../src/engine/executorEvents.js";
import { TASK_GRAPH } from "../src/config/taskGraph.js";
import { PROVIDER_CATALOG, ADVERSARIAL_CATALOG } from "../src/config/providers.js";

const PORT = 4300;

// ─── state ───────────────────────────────────────────────────────────────────
let providerHandles: ServerHandle[] = [];
let activeExecutor: TaskExecutor | undefined;
let running = false;

// ─── WebSocket broadcast ──────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });
const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
});

function broadcast(event: string, payload: unknown): void {
  const msg = JSON.stringify({ event, ...( payload as object) });
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  }
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(json);
}

async function providerHealth(): Promise<Record<string, unknown>[]> {
  const all = [
    ...new Map(PROVIDER_CATALOG.map((p) => [p.base_url, p])).values(),
    ...new Map(ADVERSARIAL_CATALOG.map((p) => [p.base_url, p])).values(),
  ];
  return Promise.all(
    all.map(async (e) => {
      try {
        const r = await fetch(`${e.base_url}/health`);
        const b = (await r.json()) as Record<string, unknown>;
        return { provider_id: e.provider_id, url: e.base_url, ok: true, ...b };
      } catch {
        return { provider_id: e.provider_id, url: e.base_url, ok: false };
      }
    }),
  );
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // CORS preflight
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  try {
    if (req.method === "GET" && url.pathname === "/api/graph") {
      send(res, 200, TASK_GRAPH);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      send(res, 200, await providerHealth());
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      if (running) { send(res, 409, { error: "already_running" }); return; }
      running = true;
      send(res, 200, { ok: true, message: "task started — watch /ws for events" });

      // Run async, don't await in the request handler
      setImmediate(async () => {
        const ledger = new Ledger(false);
        const wallet = new SimulatedWallet();
        const treasury = new Treasury(TASK_GRAPH.task_id, TASK_GRAPH.budget_cap);
        const bus = new ExecutorBus();
        activeExecutor = new TaskExecutor({ ledger, wallet, treasury, graph: TASK_GRAPH, bus });

        // Forward every bus event to WebSocket clients
        const events = [
          "task_started", "node_queued", "node_started", "node_settled",
          "node_blocked", "node_failed", "task_paused", "task_approved",
          "task_rejected", "task_done", "task_aborted",
        ] as const;
        for (const ev of events) {
          bus.on(ev, (payload) => broadcast(ev, payload));
        }

        try {
          await activeExecutor.run();
        } catch (err) {
          broadcast("task_aborted", { error: String(err) });
        } finally {
          running = false;
          activeExecutor = undefined;
        }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/approve") {
      if (!activeExecutor?.isPaused()) { send(res, 409, { error: "not_paused" }); return; }
      const body = await readBody(req);
      const delta = typeof body.delta === "number" ? body.delta : 0.5;
      activeExecutor.approve(delta);
      send(res, 200, { ok: true, delta });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/reject") {
      if (!activeExecutor?.isPaused()) { send(res, 409, { error: "not_paused" }); return; }
      activeExecutor.reject();
      send(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/fail") {
      const body = await readBody(req);
      const pid = String(body.provider_id ?? "");
      const handle = providerHandles.find((h) => h.providerId === pid);
      if (!handle || handle.external) { send(res, 404, { error: "not_found" }); return; }
      await fetch(`http://127.0.0.1:${handle.port}/admin/fail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "crash_on_complete" }),
      });
      send(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/recover") {
      const body = await readBody(req);
      const pid = String(body.provider_id ?? "");
      const handle = providerHandles.find((h) => h.providerId === pid);
      if (!handle || handle.external) { send(res, 404, { error: "not_found" }); return; }
      await fetch(`http://127.0.0.1:${handle.port}/admin/fail`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode: "none" }),
      });
      send(res, 200, { ok: true });
      return;
    }

    send(res, 404, { error: "not_found" });
  } catch (err) {
    send(res, 500, { error: "internal_error", message: String(err) });
  }
});

// Upgrade HTTP → WebSocket
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (url.pathname === "/ws") {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

// ─── startup ──────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  providerHandles = await startAllProviders({ tolerateBusy: true });
  const running = providerHandles.map((h) => `${h.providerId}@${h.port}`).join(", ");
  console.log(`Providers: ${running}`);

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`\nTrace server  http://localhost:${PORT}`);
    console.log(`WebSocket     ws://localhost:${PORT}/ws`);
    console.log(`\nUI dev server is separate — run: cd ui && npm run dev`);
    console.log(`Then open    http://localhost:5173`);
  });

  process.on("SIGINT", async () => {
    console.log("\nShutting down…");
    await stopAllProviders(providerHandles);
    server.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error("trace-server failed:", err);
  process.exitCode = 1;
});
