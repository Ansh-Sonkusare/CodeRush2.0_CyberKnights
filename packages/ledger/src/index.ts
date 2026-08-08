import { createClient, type Client } from "@libsql/client";
import {
  CreateLedgerRowRequestSchema,
  LedgerExportSchema,
  LedgerRowSchema,
  PaymentSchemeSchema,
  ReconciliationReportSchema,
  ReconciliationReportWireSchema,
  SCHEMA_VERSION,
  createLedgerRow,
  type CreateLedgerRowRequest,
  type LedgerExport,
  type LedgerOutcome,
  type LedgerRow,
  type LedgerStage,
  type PaymentScheme,
  type PolicyViolation,
  type ReconciliationReport,
  type ReconciliationReportWire,
  type ReconciliationRow,
  type ReconciliationTotals,
} from "@sentinel/schemas";

/**
 * @sentinel/ledger
 *
 * Internal append-only ledger: one row per paid call, stored in SQLite
 * (libSQL) and replayable in creation order. No HTTP surface — consumed
 * in-process by the orchestrator and, for the replay view, the gateway.
 *
 * Every read and write round-trips the row through LedgerRowSchema, so a
 * corrupted or schema-invalid row is rejected at the store boundary.
 */

export interface LedgerStore {
  insert(input: CreateLedgerRowRequest): Promise<LedgerRow>;
  get(ledgerId: string): Promise<LedgerRow | undefined>;
  updateStage(ledgerId: string, stage: LedgerStage): Promise<LedgerRow | undefined>;
  setOutcome(ledgerId: string, outcome: LedgerOutcome): Promise<LedgerRow | undefined>;
  appendViolation(ledgerId: string, violation: PolicyViolation): Promise<LedgerRow | undefined>;
  findByTaskId(taskId: string): Promise<LedgerRow[]>;
  findByNodeId(nodeId: string): Promise<LedgerRow | undefined>;
  all(): Promise<LedgerRow[]>;
  exportTask(taskId: string): Promise<LedgerExport>;
  /**
   * Build the reconciliation report for a task: one ReconciliationRow per paid
   * ledger entry plus dup-payment and budget-adherence totals. Proves "every
   * paid request tied to a result or a declared failure".
   */
  exportTaskReconciliation(taskId: string): Promise<ReconciliationReport>;
  reset(): Promise<void>;
}

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS ledger_rows (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ledger_id TEXT NOT NULL UNIQUE,
    task_id TEXT NOT NULL,
    node_id TEXT NOT NULL,
    row_json TEXT NOT NULL
  )`,
  "CREATE INDEX IF NOT EXISTS idx_ledger_rows_task ON ledger_rows(task_id)",
  "CREATE INDEX IF NOT EXISTS idx_ledger_rows_node ON ledger_rows(node_id)",
];

// ─── Reconciliation mapping ───────────────────────────────────────────────────
// LedgerRow does not store scheme/quoted/actual/tx_ref as top-level fields —
// the orchestrator records them inside stage details (payment amount, settlement
// tx_ref, etc.). The derivation below reads those details defensively: a value
// that is missing, non-numeric, or schema-invalid simply stays undefined rather
// than failing the whole report.

function readDetailValue(
  row: LedgerRow,
  stageName: string,
  keys: readonly string[],
): unknown {
  const stage = row.stages[stageName];
  if (!stage) return undefined;
  for (const key of keys) {
    const value = stage.detail[key];
    if (value !== undefined) return value;
  }
  return undefined;
}

function amountToBigint(value: unknown): bigint | undefined {
  if (typeof value === "bigint") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.round(value));
  return undefined;
}

function readAmountValue(
  row: LedgerRow,
  stageName: string,
  keys: readonly string[],
): bigint | undefined {
  return amountToBigint(readDetailValue(row, stageName, keys));
}

function readStringValue(
  row: LedgerRow,
  stageNames: readonly string[],
  keys: readonly string[],
): string | undefined {
  for (const stageName of stageNames) {
    const value = readDetailValue(row, stageName, keys);
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function readScheme(row: LedgerRow): PaymentScheme | undefined {
  for (const stageName of ["settlement", "receipt"] as const) {
    const value = readDetailValue(row, stageName, ["scheme"]);
    if (typeof value !== "string") continue;
    const parsed = PaymentSchemeSchema.safeParse(value);
    if (parsed.success) return parsed.data;
  }
  return undefined;
}

function toReconciliationRow(row: LedgerRow): ReconciliationRow {
  const quoted_amount =
    readAmountValue(row, "payment", ["amount"]) ??
    readAmountValue(row, "settlement", ["amount"]) ??
    readAmountValue(row, "402_terms", ["price"]) ??
    0n;
  const actual_amount =
    readAmountValue(row, "settlement", ["actual_amount", "actualAmount"]) ??
    readAmountValue(row, "receipt", ["actual_amount", "actualAmount"]);
  const tx_ref = readStringValue(row, ["settlement", "receipt"], ["tx_ref"]);
  const scheme = readScheme(row);

  return {
    ledger_id: row.ledger_id,
    node_id: row.node_id,
    capability: row.capability,
    provider_id: row.provider_id,
    quoted_amount,
    idempotency_key: row.idempotency_key,
    outcome: row.outcome,
    stages: row.stages,
    created_at: row.created_at,
    ...(scheme !== undefined ? { scheme } : {}),
    ...(actual_amount !== undefined ? { actual_amount } : {}),
    ...(tx_ref !== undefined ? { tx_ref } : {}),
    ...(row.violations !== undefined ? { violations: row.violations } : {}),
  };
}

function computeTotals(rows: ReconciliationRow[]): ReconciliationTotals {
  const success_count = rows.filter((r) => r.outcome === "success").length;
  const declared_failure_count = rows.filter((r) => r.outcome === "declared_failure").length;
  const pending_count = rows.length - success_count - declared_failure_count;
  const total_paid = rows.reduce((sum, r) => sum + (r.actual_amount ?? r.quoted_amount), 0n);
  // dup_payment_rate = unique idempotency keys / total rows. 1.0 when every key
  // is unique; empty task is vacuously 1.0 (no duplicates possible).
  const uniqueKeys = new Set(rows.map((r) => r.idempotency_key)).size;
  const dup_payment_rate = rows.length === 0 ? 1 : uniqueKeys / rows.length;
  // budget_adherence_ok: true when no row carries a budget_mutation or
  // scope_expansion violation. That is the structural signal the guard writes —
  // a declared_failure is NOT itself an overspend (it failed before or during a
  // payment, it did not exceed the reserved budget).
  const budget_adherence_ok = rows.every(
    (r) =>
      (r.violations?.every(
        (v) => v.type !== "budget_mutation" && v.type !== "scope_expansion",
      ) ?? true),
  );
  return {
    total_paid,
    success_count,
    declared_failure_count,
    pending_count,
    dup_payment_rate,
    budget_adherence_ok,
  };
}

/** Convert an in-process report to the wire shape (bigint money → decimal strings). */
export function toReconciliationWire(
  report: ReconciliationReport,
): ReconciliationReportWire {
  const wire = {
    task_id: report.task_id,
    generated_at: report.generated_at,
    row_count: report.row_count,
    rows: report.rows.map((r) => ({
      ledger_id: r.ledger_id,
      node_id: r.node_id,
      capability: r.capability,
      provider_id: r.provider_id,
      quoted_amount: r.quoted_amount.toString(),
      idempotency_key: r.idempotency_key,
      outcome: r.outcome,
      stages: r.stages,
      created_at: r.created_at,
      ...(r.scheme !== undefined ? { scheme: r.scheme } : {}),
      ...(r.actual_amount !== undefined ? { actual_amount: r.actual_amount.toString() } : {}),
      ...(r.tx_ref !== undefined ? { tx_ref: r.tx_ref } : {}),
      ...(r.violations !== undefined ? { violations: r.violations } : {}),
    })),
    totals: {
      total_paid: report.totals.total_paid.toString(),
      success_count: report.totals.success_count,
      declared_failure_count: report.totals.declared_failure_count,
      pending_count: report.totals.pending_count,
      dup_payment_rate: report.totals.dup_payment_rate,
      budget_adherence_ok: report.totals.budget_adherence_ok,
    },
  };
  const checked = ReconciliationReportWireSchema.safeParse(wire);
  if (!checked.success) {
    throw new Error(
      `reconciliation wire conversion failed: ${checked.error.issues.map((i) => i.message).join("; ")}`,
    );
  }
  return checked.data;
}

/** Creates a file-backed ledger store. `dbPath` is a local SQLite file path. */
export function createLedgerStore(dbPath: string): LedgerStore {
  const client: Client = createClient({ url: `file:${dbPath}`, intMode: "bigint" });
  let ready: Promise<void> | undefined;

  function ensureReady(): Promise<void> {
    if (!ready) {
      ready = client.batch(SCHEMA_SQL, "write").then(() => undefined);
    }
    return ready;
  }

  // Serialize writes. The MVD parallel pipeline runs node actors concurrently,
  // and concurrent writes to one SQLite file race (SQLITE_BUSY: database is
  // locked). Every mutating method runs through a single FIFO queue so the
  // store stays safe for parallel callers — reads stay lock-free.
  let writeTail: Promise<unknown> = Promise.resolve();
  function withWriteLock<T>(op: () => Promise<T>): Promise<T> {
    const run = writeTail.then(op, op);
    writeTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function parseRow(raw: string): LedgerRow {
    const parsed = LedgerRowSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      const detail = parsed.error.issues.map((i) => i.message).join("; ");
      throw new Error(`corrupt ledger row: ${detail}`);
    }
    return parsed.data;
  }

  async function readRow(ledgerId: string): Promise<LedgerRow | undefined> {
    await ensureReady();
    const rs = await client.execute({
      sql: "SELECT row_json FROM ledger_rows WHERE ledger_id = ?",
      args: [ledgerId],
    });
    const raw = rs.rows[0]?.["row_json"];
    if (raw === undefined) return undefined;
    if (typeof raw !== "string") return undefined;
    return parseRow(raw);
  }

  async function writeRow(row: LedgerRow): Promise<void> {
    const checked = LedgerRowSchema.safeParse(row);
    if (!checked.success) {
      const detail = checked.error.issues.map((i) => i.message).join("; ");
      throw new Error(`refusing to persist invalid ledger row ${row.ledger_id}: ${detail}`);
    }
    const rs = await client.execute({
      sql: "UPDATE ledger_rows SET row_json = ? WHERE ledger_id = ?",
      args: [JSON.stringify(checked.data), row.ledger_id],
    });
    if (rs.rowsAffected === 0) {
      throw new Error(`ledger row ${row.ledger_id} not found`);
    }
  }

  return {
    async insert(input: CreateLedgerRowRequest): Promise<LedgerRow> {
      return withWriteLock(async () => {
        await ensureReady();
        const checkedInput = CreateLedgerRowRequestSchema.safeParse(input);
        if (!checkedInput.success) {
          const detail = checkedInput.error.issues.map((i) => i.message).join("; ");
          throw new Error(`invalid ledger create request: ${detail}`);
        }
        const tx = await client.transaction("write");
        try {
          const maxRs = await tx.execute("SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM ledger_rows");
          const rawSeq = maxRs.rows[0]?.["next_seq"];
          if (rawSeq === undefined || rawSeq === null) {
            throw new Error("could not allocate ledger id");
          }
          const row = createLedgerRow({ ...checkedInput.data, ledger_id: `l-${rawSeq}` });
          const checkedRow = LedgerRowSchema.safeParse(row);
          if (!checkedRow.success) {
            throw new Error("constructed ledger row failed to serialize");
          }
          await tx.execute({
            sql: "INSERT INTO ledger_rows (ledger_id, task_id, node_id, row_json) VALUES (?, ?, ?, ?)",
            args: [checkedRow.data.ledger_id, checkedInput.data.task_id, checkedInput.data.node_id, JSON.stringify(checkedRow.data)],
          });
          await tx.commit();
          return checkedRow.data;
        } catch (err) {
          await tx.rollback().catch(() => undefined);
          throw err;
        }
      });
    },

    async get(ledgerId: string): Promise<LedgerRow | undefined> {
      return readRow(ledgerId);
    },

    async updateStage(ledgerId: string, stage: LedgerStage): Promise<LedgerRow | undefined> {
      return withWriteLock(async () => {
        const row = await readRow(ledgerId);
        if (!row) return undefined;
        row.stages[stage.name] = stage;
        await writeRow(row);
        return row;
      });
    },

    async setOutcome(ledgerId: string, outcome: LedgerOutcome): Promise<LedgerRow | undefined> {
      return withWriteLock(async () => {
        const row = await readRow(ledgerId);
        if (!row) return undefined;
        row.outcome = outcome;
        await writeRow(row);
        return row;
      });
    },

    async appendViolation(ledgerId: string, violation: PolicyViolation): Promise<LedgerRow | undefined> {
      return withWriteLock(async () => {
        const row = await readRow(ledgerId);
        if (!row) return undefined;
        row.violations = [...(row.violations ?? []), violation];
        await writeRow(row);
        return row;
      });
    },

    async findByTaskId(taskId: string): Promise<LedgerRow[]> {
      await ensureReady();
      const rs = await client.execute({
        sql: "SELECT row_json FROM ledger_rows WHERE task_id = ? ORDER BY seq",
        args: [taskId],
      });
      return rs.rows.map((r) => parseRow(String(r["row_json"])));
    },

    async findByNodeId(nodeId: string): Promise<LedgerRow | undefined> {
      await ensureReady();
      const rs = await client.execute({
        sql: "SELECT row_json FROM ledger_rows WHERE node_id = ? ORDER BY seq LIMIT 1",
        args: [nodeId],
      });
      const raw = rs.rows[0]?.["row_json"];
      if (raw === undefined) return undefined;
      return parseRow(String(raw));
    },

    async all(): Promise<LedgerRow[]> {
      await ensureReady();
      const rs = await client.execute("SELECT row_json FROM ledger_rows ORDER BY seq");
      return rs.rows.map((r) => parseRow(String(r["row_json"])));
    },

    async exportTask(taskId: string): Promise<LedgerExport> {
      const rows = await this.findByTaskId(taskId);
      const exportData = {
        schema: SCHEMA_VERSION,
        task_id: taskId,
        exported_at: new Date().toISOString(),
        row_count: rows.length,
        rows,
      };
      const checked = LedgerExportSchema.safeParse(exportData);
      if (!checked.success) {
        throw new Error("ledger export failed to serialize");
      }
      return checked.data;
    },

    async exportTaskReconciliation(taskId: string): Promise<ReconciliationReport> {
      const rows = (await this.findByTaskId(taskId)).map(toReconciliationRow);
      const report = {
        task_id: taskId,
        generated_at: new Date().toISOString(),
        row_count: rows.length,
        rows,
        totals: computeTotals(rows),
      };
      const checked = ReconciliationReportSchema.safeParse(report);
      if (!checked.success) {
        throw new Error(
          `reconciliation report failed to serialize: ${checked.error.issues.map((i) => i.message).join("; ")}`,
        );
      }
      return checked.data;
    },

    async reset(): Promise<void> {
      await ensureReady();
      await client.execute("DELETE FROM ledger_rows");
    },
  };
}
