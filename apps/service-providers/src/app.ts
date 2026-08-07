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

// ─── Wire conversions ─────────────────────────────────────────────────────────
// In-process entries keep price_micro_algo as a bigint; the HTTP wire shape
// carries it as a decimal string (see ProviderCatalogEntryWireSchema).
// toWire/fromWire live in @sentinel/providers so the orchestrator can reuse the
// exact same conversions when building routeable adapters from the catalog.

const paramIdSchema = z.object({ id: z.string().min(1) });
const paramCapabilitySchema = z.object({ capability: CapabilitySchema });

export function createProvidersApp(registry: ProviderRegistry) {
  const app = new Hono<ProviderEnv, ProviderSchema>();
  app.use("*", (c, next) => {
    c.set("registry", registry);
    return next();
  });

  // Full registry view (includes failed providers — ops/demo visibility).
  // `failed` is a registry-local knob (excluded from routing) — the shared
  // toWire can't report it, so it's attached here.
  app.get("/providers", (c) =>
    c.json(
      c
        .get("registry")
        .list()
        .map((a) => ({ ...toWire(a), failed: c.get("registry").isFailed(a.providerId) })),
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

  // Routeable catalog for one capability — excludes failed providers.
  app.get(
    "/providers/catalog/:capability",
    zValidator("param", paramCapabilitySchema),
    (c) => {
      const { capability } = c.req.valid("param");
      return c.json(
        c
          .get("registry")
          .findByCapability(capability)
          .map((a) => ({ ...toWire(a), failed: false })),
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

  app.post(
    "/providers/:id/fail",
    zValidator("param", paramIdSchema),
    (c) => {
      const reg = c.get("registry");
      const { id } = c.req.valid("param");
      if (!reg.markFailed(id)) return c.json({ message: `unknown provider "${id}"` }, 404);
      return c.json({ provider_id: id, failed: true });
    },
  );

  app.post(
    "/providers/:id/recover",
    zValidator("param", paramIdSchema),
    (c) => {
      const reg = c.get("registry");
      const { id } = c.req.valid("param");
      if (!reg.recover(id)) return c.json({ message: `unknown provider "${id}"` }, 404);
      return c.json({ provider_id: id, failed: false });
    },
  );

  // ─── In-process mock provider HTTP surface ────────────────────────────────
  // The orchestrator builds RemoteProviderAdapters from the catalog, so every
  // routeable provider must speak HTTP. These routes forward quote/deliver/
  // health to the in-process MockProvider adapters registered at boot — the
  // demo set can be paid and delivered against without separate mock servers.

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
        return c.json({ message: quoteRes.error.message }, 502);
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
        return c.json({ message: deliverRes.error.message }, 502);
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
