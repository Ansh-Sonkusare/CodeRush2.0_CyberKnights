import { createClient, type Client } from "@libsql/client";
import {
  CreateLedgerRowRequestSchema,
  LedgerExportSchema,
  LedgerRowSchema,
  SCHEMA_VERSION,
  createLedgerRow,
  type CreateLedgerRowRequest,
  type LedgerExport,
  type LedgerOutcome,
  type LedgerRow,
  type LedgerStage,
  type PolicyViolation,
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
    },

    async get(ledgerId: string): Promise<LedgerRow | undefined> {
      return readRow(ledgerId);
    },

    async updateStage(ledgerId: string, stage: LedgerStage): Promise<LedgerRow | undefined> {
      const row = await readRow(ledgerId);
      if (!row) return undefined;
      row.stages[stage.name] = stage;
      await writeRow(row);
      return row;
    },

    async setOutcome(ledgerId: string, outcome: LedgerOutcome): Promise<LedgerRow | undefined> {
      const row = await readRow(ledgerId);
      if (!row) return undefined;
      row.outcome = outcome;
      await writeRow(row);
      return row;
    },

    async appendViolation(ledgerId: string, violation: PolicyViolation): Promise<LedgerRow | undefined> {
      const row = await readRow(ledgerId);
      if (!row) return undefined;
      row.violations = [...(row.violations ?? []), violation];
      await writeRow(row);
      return row;
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

    async reset(): Promise<void> {
      await ensureReady();
      await client.execute("DELETE FROM ledger_rows");
    },
  };
}
