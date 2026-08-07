/**
 * Typed HTTP client for the gateway (:4000).
 *
 * Every response is parsed with a .strict() wire zod schema from
 * @sentinel/schemas before it's used — the UI treats the API exactly like the
 * backend treats providers: untrusted until validated. Money crosses the wire
 * as decimal strings and is parsed into bigint for display math.
 */
import { z } from "@sentinel/schemas";
import {
  ExecutionStatusWireSchema,
  LedgerExportSchema,
  LedgerRowSchema,
  ProviderCatalogEntryWireListSchema,
  RejectResponseSchema,
  RunResponseSchema,
  TaskGraphSchema,
  type ExecutionStatusWire,
  type LedgerExport,
  type LedgerRow,
  type ProviderCatalogEntryWire,
  type RejectResponse,
  type RunRequest,
  type RunResponse,
  type TaskGraph,
} from "@sentinel/schemas";

async function getJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${path}`);
  }
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(
      `invalid response from ${path}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return parsed.data;
}

async function postJson<T>(
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const data = (await res.json()) as { message?: string };
      detail = data.message ?? "";
    } catch {
      // non-JSON error body — keep detail empty
    }
    throw new Error(`HTTP ${res.status} ${path}${detail ? `: ${detail}` : ""}`);
  }
  const parsed = schema.safeParse(await res.json());
  if (!parsed.success) {
    throw new Error(
      `invalid response from ${path}: ${parsed.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return parsed.data;
}

/** POST /api/orchestrator/run — start a task execution. */
export function runTask(body: RunRequest): Promise<RunResponse> {
  return postJson("/api/orchestrator/run", body, RunResponseSchema);
}

/** POST /api/orchestrator/approve — raise the cap by `delta` (decimal string). */
export function approveTask(taskId: string, delta: string): Promise<ExecutionStatusWire> {
  return postJson(
    "/api/orchestrator/approve",
    { taskId, delta },
    ExecutionStatusWireSchema,
  );
}

/** POST /api/orchestrator/reject — deny the overspend and abort the task. */
export function rejectTask(taskId: string): Promise<RejectResponse> {
  return postJson("/api/orchestrator/reject", { taskId }, RejectResponseSchema);
}

/** GET /api/orchestrator/status/:taskId — hydrate the UI on (re)attach. */
export function getStatus(taskId: string): Promise<ExecutionStatusWire> {
  return getJson(
    `/api/orchestrator/status/${encodeURIComponent(taskId)}`,
    ExecutionStatusWireSchema,
  );
}

/** GET /api/planner/fallback — the hardcoded fallback graph for pre-run preview. */
export function getFallbackGraph(): Promise<TaskGraph> {
  return getJson("/api/planner/fallback", TaskGraphSchema);
}

/** GET /api/providers — full registry view (includes failed providers). */
export function getProviders(): Promise<ProviderCatalogEntryWire[]> {
  return getJson("/api/providers", ProviderCatalogEntryWireListSchema);
}

/** POST /api/providers/:id/fail | /recover — demo knob (mark failed/unfailed). */
export async function setProviderFailed(id: string, failed: boolean): Promise<void> {
  await postJson(
    `/api/providers/${encodeURIComponent(id)}/${failed ? "fail" : "recover"}`,
    {},
    z.object({ provider_id: z.string(), failed: z.boolean() }).strict(),
  );
}

/** GET /api/ledger/rows — all ledger rows, newest last. */
export function getLedgerRows(): Promise<LedgerRow[]> {
  return getJson("/api/ledger/rows", z.array(LedgerRowSchema));
}

/** GET /api/ledger/task/:taskId/export — replay data for one task. */
export function getLedgerExport(taskId: string): Promise<LedgerExport> {
  return getJson(
    `/api/ledger/task/${encodeURIComponent(taskId)}/export`,
    LedgerExportSchema,
  );
}
