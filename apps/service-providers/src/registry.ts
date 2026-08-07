import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ProviderAdapter, ProviderRegistry } from "@sentinel/schemas";

/**
 * In-memory ProviderRegistry for apps/service-providers (Phase 7).
 *
 * No provider catalog is hardcoded — adapters are registered at boot (the
 * Zerion / AI placeholder adapters) or at runtime via POST /providers/register.
 * A "failed" provider is a demo knob: it stays in the registry but is hidden
 * from the routeable catalog so the router/fallback path can be demoed.
 * The interface itself lives in packages/schemas (shared contract).
 *
 * The `failed` set is persisted to `statePath` (default .data/failed.json) so
 * that fail/recover knob state survives `tsx watch` hot-reloads. Without this,
 * every file save that triggers a process restart wipes the failed set and the
 * next run ignores your fail clicks.
 */
export function createInMemoryRegistry(
  statePath = ".data/failed.json",
): ProviderRegistry {
  const adapters = new Map<string, ProviderAdapter>();

  // ─── Persist helpers ────────────────────────────────────────────────────────

  function loadFailed(): Set<string> {
    try {
      if (!existsSync(statePath)) return new Set();
      const raw = readFileSync(statePath, "utf8");
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return new Set();
      return new Set(parsed.filter((x): x is string => typeof x === "string"));
    } catch {
      return new Set();
    }
  }

  function saveFailed(set: Set<string>): void {
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify([...set]), "utf8");
    } catch {
      // Non-fatal — worst case the knob resets on the next restart.
    }
  }

  const failed = loadFailed();

  return {
    register(adapter) {
      if (adapters.has(adapter.providerId)) {
        throw new Error(`provider "${adapter.providerId}" is already registered`);
      }
      adapters.set(adapter.providerId, adapter);
    },

    list() {
      return [...adapters.values()];
    },

    get(providerId) {
      return adapters.get(providerId);
    },

    findByCapability(capability) {
      return [...adapters.values()].filter(
        (adapter) => adapter.capability === capability && !failed.has(adapter.providerId),
      );
    },

    markFailed(providerId) {
      if (!adapters.has(providerId)) return false;
      failed.add(providerId);
      saveFailed(failed);
      return true;
    },

    recover(providerId) {
      if (!adapters.has(providerId)) return false;
      failed.delete(providerId);
      saveFailed(failed);
      return true;
    },

    isFailed(providerId) {
      return failed.has(providerId);
    },
  };
}
