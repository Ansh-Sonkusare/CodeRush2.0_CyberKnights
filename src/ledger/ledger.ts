import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { LedgerRow, GuardViolation } from "../types.js";
import { SCHEMA_VERSION } from "./schema.js";

const DATA_DIR = join(process.cwd(), "data");
const LEDGER_FILE = join(DATA_DIR, "ledger.json");

export class Ledger {
  private rows: LedgerRow[] = [];
  private nextId = 1;

  constructor(private shouldPersist: boolean = true) {}

  async init(): Promise<void> {
    if (!this.shouldPersist) return;
    await mkdir(DATA_DIR, { recursive: true });
    try {
      const raw = await readFile(LEDGER_FILE, "utf8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.rows)) this.rows = parsed.rows;
      if (typeof parsed.nextId === "number") this.nextId = parsed.nextId;
    } catch {
      this.rows = [];
      this.nextId = 1;
    }
  }

  async reset(): Promise<void> {
    this.rows = [];
    this.nextId = 1;
    await this.persistNow();
  }

  nextLedgerId(): string {
    const id = `l-${this.nextId}`;
    this.nextId += 1;
    return id;
  }

  async append(row: LedgerRow): Promise<LedgerRow> {
    this.rows.push(row);
    await this.persistNow();
    return row;
  }

  async updateStage(
    ledgerId: string,
    stageName: keyof LedgerRow["stages"],
    stage: LedgerRow["stages"][keyof LedgerRow["stages"]],
  ): Promise<void> {
    const row = this.get(ledgerId);
    if (!row) throw new Error(`ledger row ${ledgerId} not found`);
    row.stages[stageName] = stage;
    await this.persistNow();
  }

  async setOutcome(ledgerId: string, outcome: LedgerRow["outcome"]): Promise<void> {
    const row = this.get(ledgerId);
    if (!row) throw new Error(`ledger row ${ledgerId} not found`);
    row.outcome = outcome;
    await this.persistNow();
  }

  get(ledgerId: string): LedgerRow | undefined {
    return this.rows.find((r) => r.ledger_id === ledgerId);
  }

  findByTaskId(taskId: string): LedgerRow[] {
    return this.rows.filter((r) => r.task_id === taskId);
  }

  findByNodeId(nodeId: string): LedgerRow | undefined {
    return this.rows.find((r) => r.node_id === nodeId);
  }

  all(): LedgerRow[] {
    return [...this.rows];
  }

  /** Append a guard violation to the violations array of an existing row. */
  async appendViolation(ledgerId: string, violation: GuardViolation): Promise<void> {
    const row = this.get(ledgerId);
    if (!row) throw new Error(`ledger row ${ledgerId} not found`);
    if (!row.violations) row.violations = [];
    row.violations.push(violation);
    await this.persistNow();
  }

  /** Public alias for persistNow — used by paidCall helpers. */
  async persist(): Promise<void> {
    await this.persistNow();
  }

  async exportTask(taskId: string, outPath?: string): Promise<string> {
    const rows = this.findByTaskId(taskId);
    const trace = {
      schema: SCHEMA_VERSION,
      task_id: taskId,
      exported_at: new Date().toISOString(),
      row_count: rows.length,
      rows,
    };
    const json = JSON.stringify(trace, null, 2);
    if (outPath) {
      await mkdir(DATA_DIR, { recursive: true });
      await writeFile(outPath, json, "utf8");
    }
    return json;
  }


  private async persistNow(): Promise<void> {
    if (!this.shouldPersist) return;
    await mkdir(DATA_DIR, { recursive: true });
    const snapshot = JSON.stringify({ nextId: this.nextId, rows: this.rows }, null, 2);
    await writeFile(LEDGER_FILE, snapshot, "utf8");
  }
}
