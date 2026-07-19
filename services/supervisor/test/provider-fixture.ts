import type {
  ProviderAdapter,
  ProviderAdapterConfig,
  ProviderStepInput,
  ProviderStepResult,
} from "../src/provider.js";

function aborted(): Error {
  const error = new Error("fixture aborted");
  error.name = "AbortError";
  return error;
}

async function waitForAbort(signal: AbortSignal, honorAbort: boolean): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    if (!honorAbort) return;
    if (signal.aborted) {
      reject(aborted());
      return;
    }
    signal.addEventListener("abort", () => reject(aborted()), { once: true });
  });
}

export function createProviderAdapter(config: ProviderAdapterConfig): ProviderAdapter {
  const configKeys = Object.keys(config).sort();
  const environmentKeys = Object.keys(process.env).sort();
  return {
    providerName: config.providerName,
    model: config.model,
    async executeStep(input: ProviderStepInput): Promise<ProviderStepResult> {
      if (input.task.title.includes("stubborn-grandchild")) {
        const grandchild = spawn(process.execPath, [
          "-e",
          "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)",
        ], { stdio: "ignore" });
        if (!grandchild.pid) throw new Error("fixture grandchild did not start");
        await writeFile(
          join(config.workingDirectory, "stubborn-grandchild.pid"),
          `${grandchild.pid}\n`,
          "utf8",
        );
      }
      await input.reportCurrentAction(`Fixture ${input.phase} action`);
      if (input.task.title.includes("stubborn-grandchild")) await waitForAbort(input.signal, true);
      if (input.task.title.includes("ignore-abort")) await waitForAbort(input.signal, false);
      if (input.task.title.includes("wait-for-abort")) await waitForAbort(input.signal, true);
      if (input.task.title.includes("oversize")) {
        return { journal: "x".repeat(300_000) };
      }
      return {
        journal: JSON.stringify({
          configKeys,
          environmentKeys,
          authorization: input.authorization,
        }),
        ...(input.phase === "test"
          ? { testOutcome: "passed" as const, resultOverview: "Fixture checks passed." }
          : {}),
      };
    },
    async settleInterrupt(): Promise<void> {},
    async shutdown(): Promise<void> {},
  };
}
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
