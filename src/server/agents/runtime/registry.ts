/** Resolves configured runtime names to the Claude or Codex adapter used by task-worker launchers. */

import type { RuntimeAdapter } from "./adapter.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";

export interface RuntimeRegistry {
  get(id: string): RuntimeAdapter | null;
  ids(): readonly string[];
}

export function runtimeRegistry(adapters: readonly RuntimeAdapter[]): RuntimeRegistry {
  const byId = new Map<string, RuntimeAdapter>();
  for (const adapter of adapters) {
    if (byId.has(adapter.runtime)) throw new Error(`Duplicate runtime adapter: ${adapter.runtime}`);
    byId.set(adapter.runtime, adapter);
  }
  const ids = Object.freeze([...byId.keys()]);
  return Object.freeze({
    get(id: string): RuntimeAdapter | null {
      return byId.get(id) ?? null;
    },
    ids(): readonly string[] {
      return ids;
    },
  });
}

export function defaultRuntimeRegistry(): RuntimeRegistry {
  return runtimeRegistry([codexAdapter, claudeAdapter]);
}
