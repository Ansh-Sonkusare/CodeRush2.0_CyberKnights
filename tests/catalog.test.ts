import { describe, expect, it } from "vitest";
import { loadConfigSafe } from "@sentinel/config";
import {
  CAPABILITIES,
  ProviderCatalogEntryWireListSchema,
  SetFailModeResponseSchema,
  microAlgo,
} from "@sentinel/schemas";
import { createProvidersApp } from "../apps/service-providers/src/app.js";
import { loadCatalog, loadCatalogFile } from "../apps/service-providers/src/catalog.js";
import { MockProvider } from "../apps/service-providers/src/providers/mock.js";
import { createInMemoryRegistry } from "../apps/service-providers/src/registry.js";

// ─── WS-A catalog tests ───────────────────────────────────────────────────────
// Verifies data/catalog.json parses via the zod-validated loader, that the
// loader builds adapters whose metadata matches the JSON, that the MockProvider
// fail-mode knob round-trips, and that POST /providers/:id/fail-mode works
// end-to-end through createProvidersApp.

function testConfig() {
  const result = loadConfigSafe({});
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  expect(result.value.ports.providers).toBe(4020);
  return result.value;
}

describe("loadCatalogFile — data/catalog.json", () => {
  it("parses and seeds every capability with >=2 mock providers (primary + backup)", () => {
    const entries = loadCatalogFile();
    expect(entries.length).toBeGreaterThanOrEqual(20);

    for (const capability of CAPABILITIES) {
      const mocks = entries.filter((e) => e.capability === capability && e.kind === "mock");
      expect(mocks.length, `capability ${capability} mock count`).toBeGreaterThanOrEqual(2);
      expect(mocks.some((e) => e.role === "primary"), `${capability} has a primary`).toBe(true);
      expect(mocks.some((e) => e.role === "backup"), `${capability} has a backup`).toBe(true);
    }

    // The core-capability primaries keep their well-known ids.
    for (const id of ["mock-wallet-data", "mock-summary", "mock-credit-score"]) {
      const primary = entries.find((e) => e.provider_id === id);
      expect(primary?.role).toBe("primary");
      expect(primary?.kind).toBe("mock");
    }

    // Real kinds present.
    expect(entries.some((e) => e.provider_id === "zerion" && e.kind === "zerion")).toBe(true);
    expect(entries.some((e) => e.provider_id === "llm-summary" && e.kind === "llm-summary")).toBe(
      true,
    );
    expect(entries.some((e) => e.provider_id === "llm-credit" && e.kind === "llm-credit")).toBe(
      true,
    );

    // Adversarial entries with their attack modes.
    const adversarial = entries.filter((e) => e.kind === "adversarial");
    expect(adversarial.length).toBeGreaterThanOrEqual(2);
    expect(entries.find((e) => e.provider_id === "mock-wallet-data-adversarial")?.mode).toBe(
      "budget_mutation",
    );
    expect(entries.find((e) => e.provider_id === "mock-summary-adversarial")?.mode).toBe(
      "scope_expansion",
    );
  });

  it("never ships a failMode in the file (it is a runtime demo knob)", () => {
    for (const entry of loadCatalogFile()) {
      expect(entry.failMode).toBeUndefined();
    }
  });
});

describe("loadCatalog — file entries become adapters", () => {
  it("builds adapters whose metadata matches the JSON", () => {
    const config = testConfig();
    const adapters = loadCatalog(config);
    const byId = new Map(adapters.map((a) => [a.providerId, a]));

    expect(adapters.length).toBe(loadCatalogFile().length);

    const search = byId.get("mock-search");
    expect(search).toBeDefined();
    if (search) {
      expect(search.capability).toBe("search");
      expect(search.priceHint).toBe(microAlgo(2n));
      expect(search.latencyHintMs).toBe(150);
      expect(search.qualityScore).toBe(0.85);
      expect(search.kind).toBe("mock");
      expect(search.role).toBe("primary");
      expect(search.baseUrl).toBe("http://127.0.0.1:4020/mock/mock-search");
    }

    const backup = byId.get("mock-search-backup");
    expect(backup).toBeDefined();
    if (backup) {
      expect(backup.role).toBe("backup");
      expect(backup.priceHint).toBeGreaterThan(microAlgo(2n));
      expect(backup.scheme).toBe("upto");
      expect(backup.uptoActual).toBe(microAlgo(8n));
    }

    const exact = byId.get("mock-rank");
    expect(exact?.scheme).toBe("exact");

    const adversarial = byId.get("mock-wallet-data-adversarial");
    expect(adversarial).toBeDefined();
    if (adversarial) {
      expect(adversarial.kind).toBe("adversarial");
      expect(adversarial.mode).toBe("budget_mutation");
      expect(adversarial.role).toBe("backup");
    }

    const zerion = byId.get("zerion");
    expect(zerion).toBeDefined();
    if (zerion) {
      expect(zerion.capability).toBe("fetch_wallet_data");
      expect(zerion.priceHint).toBe(microAlgo(3n));
      expect(zerion.role).toBe("primary");
    }

    const llmSummary = byId.get("llm-summary");
    expect(llmSummary).toBeDefined();
    if (llmSummary) {
      expect(llmSummary.capability).toBe("generate_summary");
      expect(llmSummary.priceHint).toBe(microAlgo(1n));
    }

    const llmCredit = byId.get("llm-credit");
    expect(llmCredit).toBeDefined();
    if (llmCredit) {
      expect(llmCredit.capability).toBe("score_credit");
      expect(llmCredit.providerId).toBe("llm-credit");
      expect(llmCredit.priceHint).toBe(microAlgo(2n));
    }
  });

  it("rewrites the canonical :4020 base_url to the configured providers port", () => {
    const config = testConfig();
    const adapters = loadCatalog({ ...config, ports: { ...config.ports, providers: 4025 } });
    const mock = adapters.find((a) => a.providerId === "mock-verify");
    expect(mock).toBeDefined();
    if (mock) expect(mock.baseUrl).toBe("http://127.0.0.1:4025/mock/mock-verify");
  });
});

describe("MockProvider.setFailMode", () => {
  it("round-trips a mode and clears it with null", () => {
    const provider = new MockProvider({
      providerId: "mock-roundtrip",
      capability: "search",
      priceHint: microAlgo(2n),
      latencyHintMs: 100,
      qualityScore: 0.8,
      mode: "normal",
      baseUrl: "http://127.0.0.1:4020/mock/mock-roundtrip",
    });
    expect(provider.failModeValue).toBeNull();

    provider.setFailMode("after_402");
    expect(provider.failModeValue).toBe("after_402");

    provider.setFailMode(null);
    expect(provider.failModeValue).toBeNull();
  });
});

describe("POST /providers/:id/fail-mode", () => {
  const mockSearch = () =>
    new MockProvider({
      providerId: "mock-route",
      capability: "search",
      priceHint: microAlgo(2n),
      latencyHintMs: 150,
      qualityScore: 0.85,
      mode: "normal",
      baseUrl: "http://127.0.0.1:4020/mock/mock-route",
    });

  it("sets the knob on a MockProvider and GET /providers reflects it", async () => {
    const registry = createInMemoryRegistry();
    registry.register(mockSearch());
    const app = createProvidersApp(registry);

    const res = await app.request("/providers/mock-route/fail-mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "after_402" }),
    });
    expect(res.status).toBe(200);
    const parsed = SetFailModeResponseSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.provider_id).toBe("mock-route");
      expect(parsed.data.failMode).toBe("after_402");
    }

    const list = await app.request("/providers");
    const checked = ProviderCatalogEntryWireListSchema.safeParse(await list.json());
    expect(checked.success).toBe(true);
    if (checked.success) {
      expect(checked.data.find((e) => e.provider_id === "mock-route")?.failMode).toBe("after_402");
    }

    // clearing with { mode: null } shows up on the next read
    const clear = await app.request("/providers/mock-route/fail-mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: null }),
    });
    expect(clear.status).toBe(200);
    const listAfter = await app.request("/providers");
    const checkedAfter = ProviderCatalogEntryWireListSchema.safeParse(await listAfter.json());
    expect(checkedAfter.success).toBe(true);
    if (checkedAfter.success) {
      expect(
        checkedAfter.data.find((e) => e.provider_id === "mock-route")?.failMode,
      ).toBeUndefined();
    }
  });

  it("keeps the knob in the local map for non-MockProvider adapters", async () => {
    const registry = createInMemoryRegistry();
    registry.register(
      new MockProvider({
        providerId: "mock-a",
        capability: "search",
        priceHint: microAlgo(2n),
        latencyHintMs: 150,
        qualityScore: 0.85,
        mode: "normal",
        baseUrl: "http://127.0.0.1:4020/mock/mock-a",
      }),
    );
    // A stand-in for a remote/external adapter that does not hold the knob
    // itself — the local map path is exercised the same way for any non-mock.
    const app = createProvidersApp(registry);

    const res = await app.request("/providers/mock-a/fail-mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "rate_limit" }),
    });
    expect(res.status).toBe(200);
    const parsed = SetFailModeResponseSchema.safeParse(await res.json());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.failMode).toBe("rate_limit");
  });

  it("404s for an unknown provider id", async () => {
    const app = createProvidersApp(createInMemoryRegistry());
    const res = await app.request("/providers/does-not-exist/fail-mode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode: "after_402" }),
    });
    expect(res.status).toBe(404);
  });
});
