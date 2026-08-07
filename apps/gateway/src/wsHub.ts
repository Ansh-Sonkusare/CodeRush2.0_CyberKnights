import { type IncomingMessage } from "node:http";
import { type Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";

/**
 * Gateway WebSocket hub (/ws) — Phase 10.
 *
 * Serves a single `/ws` endpoint to the UI and broadcasts every live task
 * event. The event source is service-orchestrator's SSE stream
 * (GET /orchestrator/events): bridgeOrchestrator() tails that stream and
 * re-broadcasts each `data:` frame verbatim to all connected clients.
 *
 * Frames are serialized WsMessages (bigint leaves already converted to decimal
 * strings by jsonStringify at the orchestrator boundary) — the UI receives the
 * exact NodeState discriminated union the machines emit, no parallel shape.
 */
export interface WsHub {
  /** Wire into the Node http server's `upgrade` event. */
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  /** Reconnect loop: tail the orchestrator SSE stream and broadcast frames. */
  bridgeOrchestrator: (eventsUrl: string) => Promise<void>;
}

const WS_PATH = "/ws";

export function createWsHub(): WsHub {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();

  wss.on("connection", (ws) => {
    clients.add(ws);
    ws.on("close", () => clients.delete(ws));
    ws.on("error", () => clients.delete(ws));
  });

  function broadcast(frame: string): void {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(frame);
    }
  }

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === WS_PATH) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  }

  async function bridgeOrchestrator(eventsUrl: string): Promise<void> {
    while (true) {
      try {
        const res = await fetch(eventsUrl);
        if (!res.ok || !res.body) throw new Error(`SSE HTTP ${res.status}`);
        console.log(`[gateway] ws hub → ${eventsUrl}`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const dataLine = frame.split("\n").find((l) => l.startsWith("data: "));
            if (dataLine !== undefined) broadcast(dataLine.slice("data: ".length));
          }
        }
        throw new Error("SSE stream ended");
      } catch (err) {
        console.error(
          `[gateway] ws hub bridge disconnected (${eventsUrl}): ` +
            `${err instanceof Error ? err.message : String(err)} — retrying`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }

  return { handleUpgrade, bridgeOrchestrator };
}
