import { createMockProvider, DEFAULT_RESULTS } from "../src/providers/mockProvider.js";
import { PROVIDER_CATALOG } from "../src/config/providers.js";
import { Capability } from "../src/types.js";

interface ServerHandle {
  providerId: string;
  port: number;
  server: ReturnType<typeof createMockProvider>;
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

export function startAllProviders(opts?: {
  tolerateBusy?: boolean;
}): Promise<ServerHandle[]> {
  const groups = buildGroups();
  const handles: Promise<ServerHandle>[] = groups.map((group) => {
    return new Promise<ServerHandle>((resolve, reject) => {
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
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (opts?.tolerateBusy && err.code === "EADDRINUSE") {
          resolve({
            providerId: group.providerId,
            port: group.port,
            server: undefined as unknown as ServerHandle["server"],
            url: group.url,
            external: true,
          });
          return;
        }
        reject(err);
      });
      server.listen(group.port, "127.0.0.1", () => {
        resolve({
          providerId: group.providerId,
          port: group.port,
          server,
          url: group.url,
        });
      });
    });
  });
  return Promise.all(handles);
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

export type { ServerHandle };
