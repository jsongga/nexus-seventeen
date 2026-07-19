import { HttpManagerHandoffRegistrar } from "./broker-registrar.js";
import { loadManagerReviewRuntimeConfig } from "./runtime-config.js";
import { createManagerReviewService } from "./service.js";

const config = loadManagerReviewRuntimeConfig();
const handoffRegistrar = new HttpManagerHandoffRegistrar({
  brokerOrigin: config.brokerOrigin,
  handoffIssuerToken: config.brokerHandoffIssuerToken,
  ...(config.brokerTimeoutMs === undefined ? {} : { timeoutMs: config.brokerTimeoutMs }),
});
const service = await createManagerReviewService({
  workspaceId: config.workspaceId,
  storePath: config.storePath,
  evidenceIssuerToken: config.evidenceIssuerToken,
  evidenceIssuerPrincipal: config.evidenceIssuerPrincipal,
  humanToken: config.humanToken,
  managers: config.managers,
  handoffRegistrar,
  ...(config.host === undefined ? {} : { host: config.host }),
  ...(config.port === undefined ? {} : { port: config.port }),
  ...(config.maxBodyBytes === undefined ? {} : { maxBodyBytes: config.maxBodyBytes }),
  ...(config.handoffRetryMs === undefined ? {} : { handoffRetryMs: config.handoffRetryMs }),
});

const address = await service.start();
process.stdout.write(`Steward manager-review service listening on ${address.host}:${address.port}\n`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await service.close();
}

process.once("SIGINT", () => { void stop().then(() => process.exit(0)); });
process.once("SIGTERM", () => { void stop().then(() => process.exit(0)); });
