import http from "node:http";
import { randomUUID } from "node:crypto";
import { Capability } from "../types.js";

export interface ProviderCapability {
  capability: Capability;
  price: number;
  latency_ms: number;
  resultFor(goal: string, input?: Record<string, unknown>): Record<string, unknown>;
}

export type FailMode = "none" | "crash_on_complete";

export interface MockProviderConfig {
  provider_id: string;
  port: number;
  capabilities: ProviderCapability[];
  failMode?: FailMode;
}

interface Invoice {
  invoice_id: string;
  provider_id: string;
  capability: Capability;
  goal: string;
  price: number;
  completed: boolean;
  payment_ref?: string;
  result?: Record<string, unknown>;
  issued_at: string;
}

const DEFAULT_RESULTS: Record<
  Capability,
  (goal: string, input?: Record<string, unknown>) => Record<string, unknown>
> = {
  search: (_goal) => ({
    urls: [
      "https://docs.example.com/x402/overview",
      "https://blog.example.com/x402-agent-payments",
      "https://spec.example.com/rfc/x402",
    ],
    snippets: [
      "x402 is a framework for machine-to-machine payments.",
      "Agents request access, receive a 402 with terms, and pay.",
      "Idempotency keys prevent double settlement.",
    ],
  }),
  extract: (_goal, input) => ({
    title: "x402: An HTTP Payment Protocol for Agents",
    body: input?.raw ?? "Excerpt of the top search result about x402 payments.",
    word_count: 420,
  }),
  translate: (_goal, _input) => ({
    original: "x402 est un protocole de paiement HTTP pour les agents.",
    translated: "x402 is an HTTP payment protocol for agents.",
    language: "fr -> en",
  }),
  rank: (_goal, input) => ({
    ranked: [
      { url: "https://spec.example.com/rfc/x402", score: 0.93 },
      { url: "https://docs.example.com/x402/overview", score: 0.81 },
      { url: "https://blog.example.com/x402-agent-payments", score: 0.64 },
    ],
    sources_considered: input?.sources ?? [],
  }),
  verify: (_goal, _input) => ({
    verified: true,
    confidence: 0.96,
    checks: [
      "Top source is authoritative (spec site).",
      "Translated claim matches source text.",
      "No conflicting evidence in top-3 sources.",
    ],
  }),
};

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? (JSON.parse(data) as Record<string, unknown>) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function createMockProvider(config: MockProviderConfig): http.Server {
  const invoices = new Map<string, Invoice>();
  const byCapability = new Map<Capability, ProviderCapability>(
    config.capabilities.map((c) => [c.capability, c]),
  );
  let failMode: FailMode = config.failMode ?? "none";

  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        send(res, 200, {
          ok: true,
          provider_id: config.provider_id,
          capabilities: [...byCapability.keys()],
          fail_mode: failMode,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/admin/fail") {
        const body = await readBody(req);
        const mode = body.mode;
        if (mode !== "none" && mode !== "crash_on_complete") {
          send(res, 400, {
            error: "invalid_fail_mode",
            valid: ["none", "crash_on_complete"],
          });
          return;
        }
        failMode = mode;
        send(res, 200, {
          ok: true,
          provider_id: config.provider_id,
          fail_mode: failMode,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/invoice") {
        const body = await readBody(req);
        const capability = body.capability as Capability;
        const providerCap = byCapability.get(capability);
        if (!providerCap) {
          send(res, 404, {
            error: "capability_not_supported",
            provider_id: config.provider_id,
          });
          return;
        }
        const invoice: Invoice = {
          invoice_id: randomUUID(),
          provider_id: config.provider_id,
          capability,
          goal: String(body.goal ?? ""),
          price: providerCap.price,
          completed: false,
          issued_at: new Date().toISOString(),
        };
        invoices.set(invoice.invoice_id, invoice);

        await delay(Math.round(providerCap.latency_ms / 2));

        send(res, 402, {
          invoice_id: invoice.invoice_id,
          provider_id: config.provider_id,
          capability,
          price: invoice.price,
          currency: "USD",
          schema: "x402/1",
          terms_expires_at: new Date(Date.now() + 60_000).toISOString(),
          payment_required: true,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/complete") {
        const body = await readBody(req);
        const invoice = invoices.get(String(body.invoice_id));
        if (!invoice) {
          send(res, 404, { error: "invoice_not_found" });
          return;
        }
        const providerCap = byCapability.get(invoice.capability);
        if (!providerCap) {
          send(res, 500, { error: "internal" });
          return;
        }

        // Forced failure injection: provider "dies" after issuing the 402
        // and accepting payment, before delivering the result.
        if (failMode === "crash_on_complete") {
          send(res, 500, {
            error: "provider_crash_after_402",
            provider_id: config.provider_id,
            capability: invoice.capability,
          });
          return;
        }

        // Idempotent completion: a settled invoice is never settled twice.
        if (invoice.completed) {
          send(res, 200, {
            result: invoice.result,
            receipt: {
              receipt_id: invoice.payment_ref,
              tx_ref: invoice.payment_ref,
              settled_at: invoice.issued_at,
              already_settled: true,
            },
          });
          return;
        }

        await delay(providerCap.latency_ms);

        invoice.completed = true;
        invoice.payment_ref = String(body.payment_ref ?? "sim-0000");
        invoice.result = providerCap.resultFor(
          invoice.goal,
          (body.input as Record<string, unknown> | undefined) ?? undefined,
        );

        send(res, 200, {
          result: invoice.result,
          receipt: {
            receipt_id: invoice.payment_ref,
            tx_ref: invoice.payment_ref,
            provider_id: config.provider_id,
            settled_at: new Date().toISOString(),
            already_settled: false,
          },
        });
        return;
      }

      send(res, 404, { error: "not_found", path: url.pathname });
    } catch (err) {
      send(res, 500, { error: "internal_error", message: String(err) });
    }
  });

  return server;
}

export { DEFAULT_RESULTS };
