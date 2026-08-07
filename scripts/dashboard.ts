import http from "node:http";
import { startAllProviders, stopAllProviders, ServerHandle } from "./start-providers.js";
import { Ledger } from "../src/ledger/ledger.js";
import { SimulatedWallet } from "../src/wallet/wallet.js";
import { TASK_GRAPH } from "../src/config/taskGraph.js";
import { PROVIDER_CATALOG } from "../src/config/providers.js";
import { Treasury } from "../src/treasury/treasury.js";
import { TaskExecutor } from "../src/engine/executor.js";

const PORT = 4200;

const ledger = new Ledger(true);
let handles: ServerHandle[] = [];
let taskRunning = false;

let lastWallet: SimulatedWallet | undefined;

async function runDemo(): Promise<Record<string, unknown>> {
  await ledger.reset();
  const wallet = new SimulatedWallet();
  const treasury = new Treasury(TASK_GRAPH.task_id, TASK_GRAPH.budget_cap);
  const ex = new TaskExecutor({ ledger, wallet, treasury, graph: TASK_GRAPH });
  const summary = await ex.run();
  lastWallet = wallet;
  const rows = summary.steps.map((e) => ({
    node: e.step.id,
    label: e.step.label,
    provider: e.providerId ?? "-",
    price: e.price ?? 0,
    tx_ref: e.txRef ?? "-",
    outcome: e.status,
  }));
  const failed = ledger
    .findByTaskId(TASK_GRAPH.task_id)
    .filter((r) => r.outcome === "declared_failure")
    .map((r) => ({
      node: r.node_id,
      provider: r.provider_id,
      tx_ref: r.stages.settlement.detail.tx_ref ?? "-",
    }));
  return {
    task_id: TASK_GRAPH.task_id,
    rows,
    failed,
    total_spent: summary.budget.spent,
    budget_cap: summary.budget.cap,
    trace: await ledger.exportTask(TASK_GRAPH.task_id),
  };
}

async function providerHealth(): Promise<Record<string, unknown>[]> {
  const entries = [...new Map(PROVIDER_CATALOG.map((p) => [p.base_url, p])).values()];
  const health = await Promise.all(
    entries.map(async (e) => {
      try {
        const res = await fetch(`${e.base_url}/health`);
        const body = (await res.json()) as Record<string, unknown>;
        return { provider_id: e.provider_id, url: e.base_url, ok: true, ...body };
      } catch {
        return { provider_id: e.provider_id, url: e.base_url, ok: false };
      }
    }),
  );
  return health;
}

async function setProviderFailMode(
  providerId: string,
  mode: "none" | "crash_on_complete",
): Promise<Record<string, unknown>> {
  const entry = PROVIDER_CATALOG.find((p) => p.provider_id === providerId);
  if (!entry) throw new Error(`unknown provider ${providerId}`);
  const res = await fetch(`${entry.base_url}/admin/fail`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  return (await res.json()) as Record<string, unknown>;
}

function replayCheck(): Record<string, unknown> {
  if (!lastWallet) {
    return { error: "run a task first", no_double_pay: false };
  }
  const first = ledger
    .findByTaskId(TASK_GRAPH.task_id)
    .filter((r) => r.outcome === "success")
    .sort((a, b) => a.ledger_id.localeCompare(b.ledger_id))[0];
  if (!first) return { error: "no successful payment to replay", no_double_pay: false };
  const amount = Number(first.stages.settlement.detail.amount ?? 0);
  const scopeToken = `pay:${TASK_GRAPH.task_id}:up-to:${TASK_GRAPH.budget_cap}:for:${first.provider_id}`;
  const replay = lastWallet.pay({
    task_id: first.task_id,
    node_id: first.node_id,
    capability: first.capability,
    provider_id: first.provider_id,
    idempotency_key: first.idempotency_key,
    amount,
    scope_token: scopeToken,
  });
  return {
    node: first.node_id,
    provider: first.provider_id,
    key: first.idempotency_key,
    tx_ref: replay.tx_ref,
    first_payment: replay.first_payment,
    no_double_pay: !replay.first_payment,
  };
}

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>x402 Payment Router — Dashboard</title>
<style>
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background:#0f1115; color:#e6e6e6; margin:0; padding:32px; }
  h1 { font-size:20px; letter-spacing:.5px; margin:0 0 4px; }
  .sub { color:#8b93a7; font-size:13px; margin-bottom:24px; }
  .chip { display:inline-block; padding:4px 10px; border-radius:999px; font-size:12px; margin-right:8px; border:1px solid #2a2f3a; }
  .chip.ok { background:#0d2b1a; color:#4ade80; border-color:#1c4a2e; }
  .chip.down { background:#2b0d0d; color:#f87171; border-color:#4a1c1c; }
  .chip.fail { background:#2b1d0d; color:#fbbf24; border-color:#4a3a1c; }
  button { background:#2563eb; color:#fff; border:none; border-radius:6px; padding:10px 18px; font-size:14px; cursor:pointer; font-family:inherit; }
  button.small { padding:4px 10px; font-size:12px; margin-right:6px; }
  button.danger { background:#b91c1c; }
  button:disabled { background:#334155; cursor:wait; }
  table { border-collapse:collapse; width:100%; margin-top:16px; font-size:13px; }
  th, td { text-align:left; padding:8px 12px; border-bottom:1px solid #22262f; }
  th { color:#8b93a7; font-weight:500; }
  .money { color:#facc15; }
  .bar { height:8px; border-radius:4px; background:#22262f; margin-top:6px; }
  .bar > div { height:100%; border-radius:4px; background:#facc15; }
  pre { background:#0a0c10; border:1px solid #22262f; border-radius:6px; padding:16px; font-size:12px; overflow:auto; max-height:480px; }
  .card { background:#161a22; border:1px solid #22262f; border-radius:8px; padding:16px; margin-bottom:16px; }
  .row { display:flex; gap:16px; align-items:center; flex-wrap:wrap; }
</style>
</head>
<body>
  <h1>x402 Multi-Provider Agent Payment Router &amp; Treasury</h1>
  <div class="sub" id="taskinfo">task t-1 &middot; 5 steps &middot; 3 mock providers &middot; 1 parallel branch</div>
  <div class="row">
    <span class="chip ok" id="p0">search-a ?</span>
    <span class="chip ok" id="p1">lingo-b ?</span>
    <span class="chip ok" id="p2">fastrank-c ?</span>
  </div>
  <div class="sub" style="margin:10px 0 0">failure injection (kills provider after 402, before result):</div>
  <div class="row">
    <button class="small danger" onclick="setFail('search-a')">fail search-a</button>
    <button class="small" onclick="setFail('lingo-b')">fail lingo-b</button>
    <button class="small" onclick="setFail('fastrank-c')">fail fastrank-c</button>
    <button class="small" onclick="recoverAll()">recover all</button>
    <button class="small" onclick="replay()">check no-double-pay</button>
  </div>
  <div class="card" style="margin-top:16px">
    <div class="row">
      <button id="run" onclick="runDemo()">Run 5-step task</button>
      <span class="sub" id="status" style="margin:0">providers booting&hellip;</span>
    </div>
  </div>
  <div class="card">
    <h1 style="font-size:15px">Ledger</h1>
    <div id="ledger"><pre>Run the task to populate the ledger.</pre></div>
    <div id="failed" style="display:none; margin-top:10px">
      <h1 style="font-size:13px; color:#fbbf24">failed attempts (still traceable)</h1>
      <table id="failedtable"></table>
    </div>
  </div>
  <div class="card">
    <h1 style="font-size:15px">Budget</h1>
    <div id="budget">—</div>
  </div>
  <div class="card">
    <h1 style="font-size:15px">Trace (full reconciliation)</h1>
    <pre id="trace">—</pre>
  </div>
<script>
  const $ = (id) => document.getElementById(id);
  async function refreshHealth() {
    try {
      const res = await fetch('/api/health');
      const h = await res.json();
      h.forEach((p, i) => {
        const el = $('p' + i);
        if (!el) return;
        const failing = p.fail_mode === 'crash_on_complete';
        el.textContent = p.provider_id + ' ' + (p.ok ? (failing ? 'FAILING' : 'UP') : 'DOWN');
        el.className = 'chip ' + (p.ok ? (failing ? 'fail' : 'ok') : 'down');
      });
    } catch {}
  }
  async function setFail(providerId) {
    $('status').textContent = providerId + ': crash-after-402 armed';
    await fetch('/api/fail', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider_id: providerId }) });
    refreshHealth();
  }
  async function recoverAll() {
    for (const p of ['search-a', 'lingo-b', 'fastrank-c']) {
      await fetch('/api/recover', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider_id: p }) });
    }
    $('status').textContent = 'all providers recovered';
    refreshHealth();
  }
  async function replay() {
    const res = await fetch('/api/replay');
    const d = await res.json();
    if (d.error) { $('status').textContent = 'replay: ' + d.error; return; }
    $('status').textContent = 'replay ' + d.key + ' -> tx_ref ' + d.tx_ref + ', first_payment=' + d.first_payment + ' => ' + (d.no_double_pay ? 'NO DOUBLE-PAY' : 'DOUBLE-PAY (BAD)');
  }
  async function runDemo() {
    $('run').disabled = true;
    $('status').textContent = 'running 5-step task...';
    try {
      const res = await fetch('/api/run', { method: 'POST' });
      const d = await res.json();
      let rows = '';
      for (const r of d.rows) {
        rows += '<tr><td>'+r.node+'</td><td>'+r.label+'</td><td>'+r.provider+'</td><td class="money">$'+r.price.toFixed(4)+'</td><td>'+r.tx_ref+'</td><td>'+r.outcome+'</td></tr>';
      }
      $('ledger').innerHTML = '<table><tr><th>node</th><th>step</th><th>provider</th><th>price</th><th>tx_ref</th><th>outcome</th></tr>'+rows+'</table>';
      if (d.failed && d.failed.length) {
        let f = '';
        for (const x of d.failed) {
          f += '<tr><td>'+x.node+'</td><td>'+x.provider+'</td><td>'+x.tx_ref+'</td><td>declared_failure</td></tr>';
        }
        $('failed').style.display = 'block';
        $('failedtable').innerHTML = '<tr><th>node</th><th>provider</th><th>tx_ref</th><th>outcome</th></tr>' + f;
      } else {
        $('failed').style.display = 'none';
      }
      const pct = Math.min(100, (d.total_spent / d.budget_cap) * 100);
      $('budget').innerHTML = 'spent <span class="money">$'+d.total_spent.toFixed(4)+'</span> of <span class="money">$'+d.budget_cap.toFixed(4)+'</span> cap'
        + '<div class="bar"><div style="width:'+pct.toFixed(1)+'%"></div></div>';
      $('trace').textContent = JSON.stringify(JSON.parse(d.trace), null, 2);
      $('status').textContent = 'done — ' + (d.failed && d.failed.length ? d.failed.length + ' failed attempt(s) fell back, ' : '') + 'all traceable';
    } catch (e) {
      $('status').textContent = 'error: ' + e;
    } finally {
      $('run').disabled = false;
    }
  }
  refreshHealth();
  setInterval(refreshHealth, 5000);
</script>
</body>
</html>`;

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

async function main(): Promise<void> {
  await ledger.init();
  await ledger.reset();

  try {
    handles = await startAllProviders({ tolerateBusy: true });
    const running = handles.filter((h) => !h.external).length;
    console.log(`providers: ${handles.map((h) => `${h.providerId}${h.external ? " (external)" : ""}`).join(", ")}`);
    if (running === 0) console.log("note: all providers already running externally");
  } catch (err) {
    console.error("failed to start providers:", err);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(HTML);
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/health") {
        send(res, 200, await providerHealth());
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/run") {
        if (taskRunning) {
          send(res, 409, { error: "task already running" });
          return;
        }
        taskRunning = true;
        try {
          send(res, 200, await runDemo());
        } finally {
          taskRunning = false;
        }
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/fail") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const parsed = JSON.parse(raw) as { provider_id?: string };
        send(res, 200, await setProviderFailMode(String(parsed.provider_id ?? ""), "crash_on_complete"));
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/recover") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const parsed = JSON.parse(raw) as { provider_id?: string };
        send(res, 200, await setProviderFailMode(String(parsed.provider_id ?? ""), "none"));
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/replay") {
        send(res, 200, replayCheck());
        return;
      }
      send(res, 404, { error: "not_found" });
    } catch (err) {
      send(res, 500, { error: "internal_error", message: String(err) });
    }
  });

  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  console.log(`dashboard: http://127.0.0.1:${PORT}`);
  console.log("press Ctrl+C to stop");

  const shutdown = async () => {
    server.close();
    await stopAllProviders(handles);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("dashboard failed:", err);
  process.exitCode = 1;
});
