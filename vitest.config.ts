import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Root vitest config — tests live in tests/*.test.ts and import the
// @sentinel/* workspace packages by name. Each alias points at the package's
// src entry so tests run against source (no build step required).
const pkg = (name: string): string =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@sentinel/schemas": pkg("schemas"),
      "@sentinel/config": pkg("config"),
      "@sentinel/ledger": pkg("ledger"),
      "@sentinel/orchestrator": pkg("orchestrator"),
      "@sentinel/policy-guard": pkg("policy-guard"),
      "@sentinel/providers": pkg("providers"),
      "@sentinel/router": pkg("router"),
      "@sentinel/treasury": pkg("treasury"),
      "@sentinel/x402-client": pkg("x402-client"),
      "@sentinel/llm-client": pkg("llm-client"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/setup-env.ts"],
    environment: "node",
  },
});
