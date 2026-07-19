import { randomUUID } from "node:crypto";
import { Socket } from "node:net";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { FramedJsonReader, FramedJsonWriter } from "./framed-json.js";
import {
  parseProviderHostRequest,
  type ProviderHostRequest,
  type ProviderHostResponse,
} from "./provider-wire.js";
import type {
  ProviderAdapter,
  ProviderAdapterConfig,
} from "./provider.js";
import { verifyTrustedProviderModule } from "./provider-module.js";

interface ProviderAdapterModule {
  createProviderAdapter(config: ProviderAdapterConfig): ProviderAdapter | Promise<ProviderAdapter>;
}

type ActionWaiter = {
  resolve(): void;
  reject(error: Error): void;
};

type ActiveStep = {
  requestId: string;
  controller: AbortController;
  actionWaiters: Map<string, ActionWaiter>;
  completion: Promise<void>;
};

function isProviderAdapter(value: unknown): value is ProviderAdapter {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ProviderAdapter>;
  return (
    (candidate.providerName === "codex" || candidate.providerName === "claude") &&
    typeof candidate.model === "string" &&
    typeof candidate.executeStep === "function" &&
    typeof candidate.settleInterrupt === "function" &&
    typeof candidate.shutdown === "function"
  );
}

function responseError(requestId: string, message: string): ProviderHostResponse {
  return Object.freeze({ type: "error", requestId, message });
}

class ProviderHost {
  readonly #modulePath: string;
  readonly #reader: FramedJsonReader;
  readonly #writer: FramedJsonWriter;
  #config: ProviderAdapterConfig | null = null;
  #adapter: ProviderAdapter | null = null;
  #active: ActiveStep | null = null;
  #stopping = false;

  constructor(modulePath: string, transport: Socket) {
    this.#modulePath = modulePath;
    this.#reader = new FramedJsonReader(transport);
    this.#writer = new FramedJsonWriter(transport);
  }

  async run(): Promise<void> {
    try {
      for await (const raw of this.#reader) {
        if (this.#stopping) break;
        let request: ProviderHostRequest;
        try {
          request = parseProviderHostRequest(raw, this.#config?.role);
        } catch {
          await this.#writer.send(responseError("protocol", "Provider host rejected an invalid request"));
          break;
        }
        await this.#dispatch(request);
        if (this.#stopping) break;
      }
    } finally {
      this.#active?.controller.abort();
      await this.#active?.completion.catch(() => undefined);
      await this.#adapter?.shutdown().catch(() => undefined);
      await this.#writer.close().catch(() => undefined);
    }
  }

  async #dispatch(request: ProviderHostRequest): Promise<void> {
    switch (request.type) {
      case "initialize":
        await this.#initialize(request);
        return;
      case "execute":
        if (!this.#adapter || !this.#config || this.#active) {
          await this.#writer.send(responseError(request.requestId, "Provider host is not ready for a step"));
          return;
        }
        if (
          request.input.authorization.role !== this.#config.role ||
          request.input.authorization.phase !== request.input.phase
        ) {
          await this.#writer.send(responseError(request.requestId, "Provider step authorization was denied"));
          return;
        }
        this.#startStep(request);
        return;
      case "current_action_ack": {
        const active = this.#active;
        const waiter = active?.requestId === request.requestId
          ? active.actionWaiters.get(request.actionId)
          : undefined;
        if (!waiter) {
          await this.#writer.send(responseError(request.requestId, "Current action acknowledgement is not pending"));
          return;
        }
        active!.actionWaiters.delete(request.actionId);
        if (request.accepted) waiter.resolve();
        else waiter.reject(new Error("Supervisor rejected the current action"));
        return;
      }
      case "abort":
        if (this.#active?.requestId === request.requestId) this.#active.controller.abort();
        return;
      case "settle_interrupt":
        if (!this.#adapter || this.#active) {
          await this.#writer.send(responseError(request.requestId, "Provider host cannot settle the interrupt"));
          return;
        }
        try {
          await this.#adapter.settleInterrupt(request.context);
          await this.#writer.send({ type: "interrupt_settled", requestId: request.requestId });
        } catch {
          await this.#writer.send(responseError(request.requestId, "Provider interrupt settlement failed"));
        }
        return;
      case "shutdown":
        this.#stopping = true;
        this.#active?.controller.abort();
        await this.#active?.completion.catch(() => undefined);
        try {
          await this.#adapter?.shutdown();
          this.#adapter = null;
          await this.#writer.send({ type: "shutdown_complete", requestId: request.requestId });
        } catch {
          await this.#writer.send(responseError(request.requestId, "Provider shutdown failed"));
        }
        return;
    }
  }

  async #initialize(request: Extract<ProviderHostRequest, { type: "initialize" }>): Promise<void> {
    if (this.#adapter || this.#config) {
      await this.#writer.send(responseError(request.requestId, "Provider host is already initialized"));
      return;
    }
    try {
      const loaded = await import(pathToFileURL(this.#modulePath).href) as Partial<ProviderAdapterModule>;
      if (typeof loaded.createProviderAdapter !== "function") throw new Error("invalid adapter module");
      const adapter = await loaded.createProviderAdapter(request.config);
      if (!isProviderAdapter(adapter)) throw new Error("invalid adapter");
      if (
        adapter.providerName !== request.config.providerName ||
        adapter.model !== request.config.model
      ) {
        throw new Error("adapter identity mismatch");
      }
      this.#config = request.config;
      this.#adapter = adapter;
      await this.#writer.send({
        type: "ready",
        requestId: request.requestId,
        providerName: adapter.providerName,
        model: adapter.model,
      });
    } catch {
      await this.#writer.send(responseError(request.requestId, "Provider adapter initialization failed"));
    }
  }

  #startStep(request: Extract<ProviderHostRequest, { type: "execute" }>): void {
    const adapter = this.#adapter!;
    const controller = new AbortController();
    const actionWaiters = new Map<string, ActionWaiter>();
    const active: ActiveStep = {
      requestId: request.requestId,
      controller,
      actionWaiters,
      completion: Promise.resolve(),
    };
    this.#active = active;
    active.completion = (async () => {
      try {
        const result = await adapter.executeStep({
          ...request.input,
          signal: controller.signal,
          reportCurrentAction: async (summary) => {
            if (controller.signal.aborted) throw new Error("Provider step was aborted");
            const actionId = randomUUID();
            const acknowledgement = new Promise<void>((resolve, reject) => {
              actionWaiters.set(actionId, { resolve, reject });
            });
            await this.#writer.send({
              type: "current_action",
              requestId: request.requestId,
              actionId,
              summary,
            });
            await acknowledgement;
          },
        });
        await this.#writer.send({ type: "result", requestId: request.requestId, result });
      } catch {
        const message = controller.signal.aborted
          ? "Provider step aborted"
          : "Provider adapter step failed";
        await this.#writer.send(responseError(request.requestId, message));
      } finally {
        for (const waiter of actionWaiters.values()) waiter.reject(new Error("Provider step ended"));
        actionWaiters.clear();
        if (this.#active === active) this.#active = null;
      }
    })();
  }
}

export async function runProviderHost(
  modulePath: string,
  expectedSha256: string,
  transportFd = 3,
): Promise<void> {
  if (!isAbsolute(modulePath)) throw new Error("Provider adapter module path must be absolute");
  await verifyTrustedProviderModule({ modulePath, expectedSha256 });
  const transport = new Socket({ fd: transportFd, readable: true, writable: true });
  await new ProviderHost(modulePath, transport).run();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const modulePath = process.argv[2];
  const expectedSha256 = process.argv[3];
  if (!modulePath || !expectedSha256) {
    process.exitCode = 1;
  } else {
    runProviderHost(modulePath, expectedSha256).catch(() => {
      process.exitCode = 1;
    });
  }
}
