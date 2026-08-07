import type { ProviderAdapter, ProviderRegistry } from "@sentinel/schemas";

/**
 * In-memory ProviderRegistry for apps/service-providers.
 *
 * Adapters are registered at boot (Zerion, LLM, mock set) or at runtime via
 * POST /providers/register. The registry is the catalog — it never filters
 * providers from routing based on a "failed" flag. Failure is a property of
 * the provider itself:
 *
 *   - MockProviders: `adapter.setFailed()` makes quote()/deliver() return err,
 *     which the HTTP mock routes surface as HTTP 503. The orchestrator's node
 *     machine sees the 503, treats it as a retriable failure, and tries the
 *     next candidate. No routing exclusion needed.
 *
 *   - RemoteProviderAdapters (real external providers): the registry's
 *     markFailed/recover/isFailed knob still exists as a manual operator
 *     override for genuinely dead remotes that you can't reach to toggle
 *     directly. This is surfaced in the UI's `failed` field.
 *
 * The interface itself lives in packages/schemas (shared contract).
 */
export function createInMemoryRegistry(): ProviderRegistry {
  const adapters = new Map<string, ProviderAdapter>();
  // Manual failed set for non-mock (remote) providers only.
  const failed = new Set<string>();

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
      // Does not filter out failed providers — callers (the /catalog endpoint)
      // receive the full set. The orchestrator uses GET /providers directly and
      // builds its own adapter list; it does not call this endpoint.
      return [...adapters.values()].filter(
        (adapter) => adapter.capability === capability,
      );
    },

    markFailed(providerId) {
      if (!adapters.has(providerId)) return false;
      failed.add(providerId);
      return true;
    },

    recover(providerId) {
      if (!adapters.has(providerId)) return false;
      failed.delete(providerId);
      return true;
    },

    isFailed(providerId) {
      return failed.has(providerId);
    },
  };
}
