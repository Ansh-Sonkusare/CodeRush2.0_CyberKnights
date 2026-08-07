/**
 * @sentinel/providers
 *
 * Shared provider wire contracts.
 *
 * The RemoteProviderAdapter here is the ONE implementation of the
 * ProviderAdapter interface that speaks HTTP to an external provider server
 * (the /quote + /deliver + /health wire contract). It is used by:
 *  - apps/service-providers — attaching external servers via POST /providers/register
 *  - apps/service-orchestrator — building routeable adapters from the catalog
 *    fetched over HTTP, so NodeMachine can call quote/deliver on any provider
 *
 * Wire entries (ProviderCatalogEntryWire) carry price_micro_algo as a decimal
 * string; in-process entries keep it as a bigint. toWire/fromWire are the only
 * two conversion points.
 */

export * from "./remote.js";
