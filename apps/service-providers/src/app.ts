import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import {
  CapabilitySchema,
  RegisterProviderRequestSchema,
  type ProviderEnv,
  type ProviderRegistry,
  type ProviderSchema,
} from "@sentinel/schemas";
import { RemoteProviderAdapter, fromWire, toWire } from "@sentinel/providers";
import { MockProvider } from "./providers/mock.js";

// ─── Wire conversions ─────────────────────────────────────────────────────────
// In-process entries keep price_micro_algo as a bigint; the HTTP wire shape
// carries it as a decimal string (see ProviderCatalogEntryWireSchema).
// toWire/fromWire live in @sentinel/providers so the orchestrator can reuse the
// exact same conversions when building routeable adapters from the catalog.

const paramIdSchema = z.object({ id: z.string().min(1) });
const paramCapabilitySchema = z.object({ capability: CapabilitySchema });

/**
 * Return true if the adapter should be shown as "failed" in the UI.
 * For in-process MockProviders, read the flag on the adapter itself — the
 * adapter is the source of truth for service-level failure.
 * For RemoteProviderAdapters (external providers), fall back to the registry's
 * explicit failed set (which is how a human operator marks a known-dead remote).
 */
function isFailed(adapter: unknown, registry: ProviderRegistry, providerId: string): boolean {
  if (adapter instanceof MockProvider) return adapter.isFailed;
  return registry.isFailed(providerId);
}

export function createProvidersApp(registry: ProviderRegistry) {
  const app = new Hono<ProviderEnv, ProviderSchema>();
  app.use("*", (c, next) => {
    c.set("registry", registry);
    return next();
  });

  // Full registry view (includes all providers — ops/demo visibility).
  // `failed` reflects the adapter's own outage state for mocks, or the
  // registry knob for remote providers.
  app.get("/providers", (c) =>
    c.json(
      c
        .get("registry")
        .list()
        .map((a) => ({ ...toWire(a), failed: isFailed(a, c.get("registry"), a.providerId) })),
    ),
  );

  // Attach an external provider server over HTTP (remote proxy adapter).
  app.post(
    "/providers/register",
    zValidator("json", RegisterProviderRequestSchema),
    (c) => {
      const reg = c.get("registry");
      const { entry } = c.req.valid("json");
      if (reg.get(entry.provider_id)) {
        return c.json({ message: `provider "${entry.provider_id}" is already registered` }, 409);
      }
      reg.register(new RemoteProviderAdapter(fromWire(entry)));
      return c.json(entry, 201);
    },
  );

  // Routeable catalog for one capability — for mocks, include even failed ones
  // (they will fail at the HTTP layer and the orchestrator will retry/fallback).
  app.get(
    "/providers/catalog/:capability",
    zValidator("param", paramCapabilitySchema),
    (c) => {
      const { capability } = c.req.valid("param");
      return c.json(
        c
          .get("registry")
          .findByCapability(capability)
          .map((a) => ({ ...toWire(a), failed: isFailed(a, c.get("registry"), a.providerId) })),
      );
    },
  );

  app.get(
    "/providers/:id/health",
    zValidator("param", paramIdSchema),
    async (c) => {
      const reg = c.get("registry");
      const { id } = c.req.valid("param");
      const adapter = reg.get(id);
      if (!adapter) return c.json({ message: `unknown provider "${id}"` }, 404);
      const health = await adapter.health();
      return c.json({ provider_id: id, ...health });
    },
  );

  // ─── Fail / recover knobs ─────────────────────────────────────────────────
  // For MockProviders: sets the _failed flag on the adapter directly — the
  // next quote()/deliver() call returns a service-level error, exactly as a
  // real external provider would behave when it returns HTTP 503. The
  // orchestrator still routes to it; the node machine's retry/fallback path
  // handles the failure.
  //
  // For RemoteProviderAdapters: falls back to the registry's markFailed/recover
  // (routing exclusion), which is the right model for a genuinely dead remote —
  // you'd have no other way to signal the failure from this service.

  app.post(
    "/providers/:id/fail",
    zValidator("param", paramIdSchema),
    (c) => {
      const reg = c.get("registry");
      const { id } = c.req.valid("param");
      const adapter = reg.get(id);
      if (!adapter) return c.json({ message: `unknown provider "${id}"` }, 404);
      if (adapter instanceof MockProvider) {
        adapter.setFailed();
      } else {
        reg.markFailed(id);
      }
      return c.json({ provider_id: id, failed: true });
    },
  );

  app.post(
    "/providers/:id/recover",
    zValidator("param", paramIdSchema),
    (c) => {
      const reg = c.get("registry");
      const { id } = c.req.valid("param");
      const adapter = reg.get(id);
      if (!adapter) return c.json({ message: `unknown provider "${id}"` }, 404);
      if (adapter instanceof MockProvider) {
        adapter.setRecovered();
      } else {
        reg.recover(id);
      }
      return c.json({ provider_id: id, failed: false });
    },
  );

  // Recover all providers at once — useful for demo resets.
  app.post("/providers/recover-all", (c) => {
    const reg = c.get("registry");
    const recovered: string[] = [];
    for (const adapter of reg.list()) {
      if (adapter instanceof MockProvider) {
        if (adapter.isFailed) {
          adapter.setRecovered();
          recovered.push(adapter.providerId);
        }
      } else if (reg.isFailed(adapter.providerId)) {
        reg.recover(adapter.providerId);
        recovered.push(adapter.providerId);
      }
    }
    return c.json({ recovered });
  });

  // ─── In-process mock provider HTTP surface ────────────────────────────────
  // The orchestrator builds RemoteProviderAdapters from the catalog, so every
  // routeable provider must speak HTTP. These routes forward quote/deliver/
  // health to the in-process MockProvider adapters registered at boot — the
  // demo set can be paid and delivered against without separate mock servers.
  //
  // When a MockProvider has _failed=true, adapter.quote() returns err(...),
  // and this route returns 503 — exactly what a real external provider that is
  // down would do. The RemoteProviderAdapter in the orchestrator catches the
  // non-2xx response and returns err(kind=timeout), which the node machine
  // treats as a retriable failure.

  app.post(
    "/mock/:id/quote",
    zValidator("param", paramIdSchema),
    zValidator(
      "json",
      z.object({ goal: z.string() }).strict(),
    ),
    async (c) => {
      const reg = c.get("registry");
      const { id } = c.req.valid("param");
      const adapter = reg.get(id);
      if (!adapter) return c.json({ message: `unknown mock provider "${id}"` }, 404);
      const quoteRes = await adapter.quote(c.req.valid("json").goal);
      if (!quoteRes.ok) {
        return c.json({ message: quoteRes.error.message }, 503);
      }
      return c.json(quoteRes.value);
    },
  );

  app.post(
    "/mock/:id/deliver",
    zValidator("param", paramIdSchema),
    zValidator(
      "json",
      z
        .object({
          invoice_id: z.string(),
          payment_ref: z.string(),
          input: z.record(z.string(), z.unknown()).optional(),
        })
        .strict(),
    ),
    async (c) => {
      const reg = c.get("registry");
      const { id } = c.req.valid("param");
      const adapter = reg.get(id);
      if (!adapter) return c.json({ message: `unknown mock provider "${id}"` }, 404);
      const { invoice_id, payment_ref, input } = c.req.valid("json");
      const deliverRes = await adapter.deliver(invoice_id, payment_ref, input);
      if (!deliverRes.ok) {
        return c.json({ message: deliverRes.error.message }, 503);
      }
      return c.json(deliverRes.value);
    },
  );

  app.get("/mock/:id/health", zValidator("param", paramIdSchema), async (c) => {
    const reg = c.get("registry");
    const { id } = c.req.valid("param");
    const adapter = reg.get(id);
    if (!adapter) return c.json({ message: `unknown mock provider "${id}"` }, 404);
    return c.json(await adapter.health());
  });

  return app;
}
