import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRuntimeProfiles, type RuntimeProfile } from "../../../../src/server/agents/runtime/profiles.js";

export const SHIPPED_RUNTIME_PROFILES = parseRuntimeProfiles(
  JSON.parse(readFileSync(join(process.cwd(), "config", "runtimes.json"), "utf8")) as unknown
);

export function shippedRuntimeProfile(runtime: "codex" | "claude"): RuntimeProfile {
  const profile = SHIPPED_RUNTIME_PROFILES.runtimes.get(runtime);
  if (profile === undefined) throw new Error(`Shipped runtime profile is missing ${runtime}`);
  return profile;
}

export const CODEX_PROFILE = shippedRuntimeProfile("codex");
export const CLAUDE_PROFILE = shippedRuntimeProfile("claude");
