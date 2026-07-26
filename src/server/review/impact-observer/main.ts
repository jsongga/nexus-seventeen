import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { createModelRouter } from "#shared/model-routing";
import { loadImpactObserverConfig } from "./config.js";
import { ImpactObserverDaemon } from "./daemon.js";
import { HttpImpactEventSource } from "./http-source.js";
import { FakeWeakImpactModelAdapter } from "./model.js";
import { ImpactObserver } from "./observer.js";
import { ImpactSummaryStore } from "./store.js";
import { ImpactSummaryServer } from "./summary-server.js";
import type { WeakImpactModelAdapter } from "./types.js";

interface AdapterModule {
  createImpactModelAdapter(): WeakImpactModelAdapter | Promise<WeakImpactModelAdapter>;
}

function validAdapter(value: unknown): value is WeakImpactModelAdapter {
  if (typeof value !== "object" || value === null) return false;
  const adapter = value as Partial<WeakImpactModelAdapter>;
  return typeof adapter.name === "string" && adapter.name.length > 0 && typeof adapter.summarize === "function";
}

async function loadAdapter(fake: boolean, modulePath: string | null): Promise<WeakImpactModelAdapter> {
  if (fake) return new FakeWeakImpactModelAdapter();
  if (modulePath === null || !isAbsolute(modulePath)) throw new Error("A valid impact model adapter path is required");
  const loaded = await import(pathToFileURL(modulePath).href) as Partial<AdapterModule>;
  if (typeof loaded.createImpactModelAdapter !== "function") {
    throw new Error("Impact adapter module must export createImpactModelAdapter()");
  }
  const adapter = await loaded.createImpactModelAdapter();
  if (!validAdapter(adapter)) throw new Error("Impact adapter module returned an invalid adapter");
  return adapter;
}

const CONSOLE_LOGGER = Object.freeze({
  info(message: string) { process.stdout.write(`${message}\n`); },
  warn(message: string) { process.stderr.write(`${message}\n`); },
  error(message: string) { process.stderr.write(`${message}\n`); },
});

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const config = loadImpactObserverConfig(env);
  const model = await loadAdapter(config.fakeModel, config.adapterModulePath);
  const persistence = new ImpactSummaryStore({
    path: config.statePath,
    workspaceId: config.workspaceId,
    maximumSummaries: config.limits.maxTrackedTasks,
    maximumSummaryCharacters: config.limits.maxSummaryChars,
  });
  const observer = new ImpactObserver({
    workspaceId: config.workspaceId,
    model,
    router: createModelRouter(config.modelCatalog),
    persistence,
    limits: config.limits,
  });
  const source = new HttpImpactEventSource({
    controlPlaneOrigin: config.controlPlaneOrigin,
    workspaceId: config.workspaceId,
    readToken: config.readToken,
  });
  const daemon = new ImpactObserverDaemon({
    observer,
    source,
    reconnectMinimumMs: config.reconnectMinimumMs,
    reconnectMaximumMs: config.reconnectMaximumMs,
    logger: CONSOLE_LOGGER,
  });
  const server = new ImpactSummaryServer({
    observer,
    workspaceId: config.workspaceId,
    outputToken: config.outputToken,
    host: config.host,
    port: config.port,
    corsOrigins: config.corsOrigins,
  });
  const address = await server.start();
  process.stdout.write(`Steward impact summaries listening at ${address.url}\n`);

  const stop = new AbortController();
  const requestStop = () => stop.abort();
  process.once("SIGINT", requestStop);
  process.once("SIGTERM", requestStop);
  try {
    await daemon.run(stop.signal);
  } finally {
    process.removeListener("SIGINT", requestStop);
    process.removeListener("SIGTERM", requestStop);
    await server.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Impact observer failed";
    process.stderr.write(`${message.replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")}\n`);
    process.exitCode = 1;
  });
}
