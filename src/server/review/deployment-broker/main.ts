import { createDeploymentBroker } from "./service.js";

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function optionalInteger(name: string): number | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new Error(`${name} must be a non-negative integer`);
  return Number(value);
}

const configuredPort = optionalInteger("STEWARD_DEPLOYMENT_PORT");
const service = await createDeploymentBroker({
  storePath: required("STEWARD_DEPLOYMENT_STORE_PATH"),
  humanToken: required("STEWARD_DEPLOYMENT_HUMAN_TOKEN"),
  handoffIssuerToken: required("STEWARD_DEPLOYMENT_HANDOFF_ISSUER_TOKEN"),
  executorToken: required("STEWARD_DEPLOYMENT_EXECUTOR_TOKEN"),
  humanPrincipal: required("STEWARD_DEPLOYMENT_HUMAN_PRINCIPAL"),
  handoffIssuerPrincipal: required("STEWARD_DEPLOYMENT_HANDOFF_ISSUER_PRINCIPAL"),
  executorPrincipal: required("STEWARD_DEPLOYMENT_EXECUTOR_PRINCIPAL"),
  targetEnvironments: required("STEWARD_DEPLOYMENT_TARGET_ENVIRONMENTS").split(","),
  ...(process.env.STEWARD_DEPLOYMENT_HOST === undefined ? {} : { host: process.env.STEWARD_DEPLOYMENT_HOST }),
  ...(configuredPort === undefined ? {} : { port: configuredPort }),
});

const address = await service.start();
process.stdout.write(`Steward deployment broker listening on ${address.host}:${address.port}\n`);

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await service.close();
}
process.once("SIGINT", () => { void stop().then(() => process.exit(0)); });
process.once("SIGTERM", () => { void stop().then(() => process.exit(0)); });
