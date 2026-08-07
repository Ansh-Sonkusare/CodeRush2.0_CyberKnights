import { createMockProvider, DEFAULT_RESULTS } from "../src/providers/mockProvider.js";
import { createAdversarialProvider } from "../src/providers/adversarialProvider.js";
import { PROVIDER_CATALOG, ADVERSARIAL_CATALOG } from "../src/config/providers.js";
import { Capability } from "../src/types.js";
import http from "node:http";

export interface ServerHandle {
  providerId: string;
  port: number;
  server: http.Server;
  url: string;
  external?: boolean;
}

interface ProviderGroup {
  providerId: string;
  port: number;
  url: string;
  caps: { capability: Capability; price: number; latency_ms: number }[];
}

function buildGroups(): ProviderGroup[] {
  const groups = new Map<string, ProviderGroup>();
  for (const entry of PROVIDER_CATALOG) {
    let group = groups.get(entry.provider_id);
    if (!group) {
      const port = Number(new URL(entry.base_url).port);
      group = {
        providerId: entry.provider_id,
        port,
        url: entry.base_url,
        caps: [],
      };
      groups.set(entry.provider_id, group);
    }
    group.caps.push({
      capability: entry.capability,
      price: entry.price,
      latency_ms: entry.latency_ms,
    });
  }
  return [...groups.values()];
}

function listenServer(
  server: http.Server,
  port: number,
  opts?: { tolerateBusy?: boolean },
): Promise<{ external: boolean }> {
  return new Promise((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (opts?.tolerateBusy && err.code === "EADDRINUSE") {
        resolve({ external: true });
        return;
      }
      reject(err);
    });
    server.listen(port, "127.0.0.1", () => resolve({ external: false }));
  });
}

export async function startAllProviders(opts?: {
  tolerateBusy?: boolean;
  includeAdversarial?: boolean;
}): Promise<ServerHandle[]> {
  const groups = buildGroups();
  const handles: ServerHandle[] = [];

  // Start normal (mock) providers
  for (const group of groups) {
    const server = createMockProvider({
      provider_id: group.providerId,
      port: group.port,
      capabilities: group.caps.map((c) => ({
        capability: c.capability,
        price: c.price,
        latency_ms: c.latency_ms,
        resultFor: DEFAULT_RESULTS[c.capability],
      })),
    });
    const { external } = await listenServer(server, group.port, opts);
    handles.push({
      providerId: group.providerId,
      port: group.port,
      server,
      url: group.url,
      external,
    });
  }

  // Start adversarial providers if requested (or by default)
  if (opts?.includeAdversarial !== false) {
    for (const entry of ADVERSARIAL_CATALOG) {
      const port = Number(new URL(entry.base_url).port);
      const server = createAdversarialProvider({
        provider_id: entry.provider_id,
        port,
        capability: entry.capability,
        price: entry.price,
        latency_ms: entry.latency_ms,
        mode: entry.adversarial_mode,
      });
      const { external } = await listenServer(server, port, opts);
      handles.push({
        providerId: entry.provider_id,
        port,
        server,
        url: entry.base_url,
        external,
      });
    }
  }

  return handles;
}

export function stopAllProviders(handles: ServerHandle[]): Promise<void> {
  return Promise.all(
    handles
      .filter((h) => !h.external && h.server)
      .map(
        (h) =>
          new Promise<void>((resolve) => h.server.close(() => resolve())),
      ),
  ).then(() => undefined);
}
