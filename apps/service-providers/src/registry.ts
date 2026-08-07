import type { ProviderAdapter, ProviderRegistry } from "@sentinel/schemas";

/**
 * In-memory ProviderRegistry for apps/service-providers (Phase 7).
 *
 * No provider catalog is hardcoded — adapters are registered at boot (the
 * Zerion / AI placeholder adapters) or at runtime via POST /providers/register.
 * A "failed" provider is a demo knob: it stays in the registry but is hidden
 * from the routeable catalog so the router/fallback path can be demoed.
 * The interface itself lives in packages/schemas (shared contract).
 */
export function createInMemoryRegistry(): ProviderRegistry {
  const adapters = new Map<string, ProviderAdapter>();
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
      return [...adapters.values()].filter(
        (adapter) => adapter.capability === capability && !failed.has(adapter.providerId),
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
