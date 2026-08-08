import { readFileSync } from "node:fs";

// Load the repo-root .env into process.env so live (network) provider tests can
// find real API keys. Vite/Vitest does not inject .env files into process.env
// by default. Vars already set in the shell win over the file.
const envPath = new URL("../.env", import.meta.url);
try {
  const text = readFileSync(envPath, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = value;
  }
} catch {
  // no .env present — live tests will be skipped, unit tests still run
}
