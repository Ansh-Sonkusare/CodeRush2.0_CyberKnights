import { Capability, ProviderCatalogEntry } from "../types.js";

const PORTS = {
  search: 4101,
  lingo: 4102,
  rank: 4103,
} as const;

export const PROVIDER_CATALOG: ProviderCatalogEntry[] = [
  // ---- search-a : primary search, backups for extract/translate ----
  {
    provider_id: "search-a",
    capability: "search",
    price: 0.02,
    latency_ms: 400,
    quality_score: 0.85,
    base_url: `http://127.0.0.1:${PORTS.search}`,
    role: "primary",
  },
  {
    provider_id: "search-a",
    capability: "extract",
    price: 0.045,
    latency_ms: 380,
    quality_score: 0.77,
    base_url: `http://127.0.0.1:${PORTS.search}`,
    role: "backup",
  },
  {
    provider_id: "search-a",
    capability: "translate",
    price: 0.05,
    latency_ms: 600,
    quality_score: 0.73,
    base_url: `http://127.0.0.1:${PORTS.search}`,
    role: "backup",
  },
  // ---- lingo-b : primary extract/translate, backups for rank/verify ----
  {
    provider_id: "lingo-b",
    capability: "extract",
    price: 0.03,
    latency_ms: 300,
    quality_score: 0.9,
    base_url: `http://127.0.0.1:${PORTS.lingo}`,
    role: "primary",
  },
  {
    provider_id: "lingo-b",
    capability: "translate",
    price: 0.035,
    latency_ms: 320,
    quality_score: 0.88,
    base_url: `http://127.0.0.1:${PORTS.lingo}`,
    role: "primary",
  },
  {
    provider_id: "lingo-b",
    capability: "rank",
    price: 0.04,
    latency_ms: 420,
    quality_score: 0.71,
    base_url: `http://127.0.0.1:${PORTS.lingo}`,
    role: "backup",
  },
  {
    provider_id: "lingo-b",
    capability: "verify",
    price: 0.055,
    latency_ms: 500,
    quality_score: 0.75,
    base_url: `http://127.0.0.1:${PORTS.lingo}`,
    role: "backup",
  },
  // ---- fastrank-c : primary rank/verify, backup for search ----
  {
    provider_id: "fastrank-c",
    capability: "rank",
    price: 0.015,
    latency_ms: 250,
    quality_score: 0.7,
    base_url: `http://127.0.0.1:${PORTS.rank}`,
    role: "primary",
  },
  {
    provider_id: "fastrank-c",
    capability: "verify",
    price: 0.04,
    latency_ms: 350,
    quality_score: 0.8,
    base_url: `http://127.0.0.1:${PORTS.rank}`,
    role: "primary",
  },
  {
    provider_id: "fastrank-c",
    capability: "search",
    price: 0.033,
    latency_ms: 520,
    quality_score: 0.74,
    base_url: `http://127.0.0.1:${PORTS.rank}`,
    role: "backup",
  },
];

export function catalogFor(capability: Capability): ProviderCatalogEntry[] {
  return PROVIDER_CATALOG.filter((p) => p.capability === capability);
}

export const PROVIDER_PORTS = PORTS;
