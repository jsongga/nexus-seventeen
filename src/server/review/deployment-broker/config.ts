import { BrokerError } from "./errors.js";

export interface DeploymentBrokerOptions {
  readonly storePath: string;
  readonly humanToken: string;
  readonly handoffIssuerToken: string;
  readonly executorToken: string;
  readonly humanPrincipal: string;
  readonly handoffIssuerPrincipal: string;
  readonly executorPrincipal: string;
  readonly targetEnvironments: readonly string[];
  readonly host?: string;
  readonly port?: number;
  readonly maxBodyBytes?: number;
  readonly maxTextLength?: number;
  readonly minimumExpirySeconds?: number;
  readonly maximumExpirySeconds?: number;
  readonly now?: () => Date;
}

export interface DeploymentBrokerConfig {
  readonly storePath: string;
  readonly humanToken: string;
  readonly handoffIssuerToken: string;
  readonly executorToken: string;
  readonly humanPrincipal: string;
  readonly handoffIssuerPrincipal: string;
  readonly executorPrincipal: string;
  readonly targetEnvironments: ReadonlySet<string>;
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly maxTextLength: number;
  readonly minimumExpirySeconds: number;
  readonly maximumExpirySeconds: number;
  readonly now: () => Date;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new BrokerError(500, "INVALID_CONFIGURATION", `${name} is outside its safe range`);
  }
  return resolved;
}

function configText(value: string, name: string, maximum: number): string {
  if (
    value.length === 0 ||
    value.length > maximum ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new BrokerError(500, "INVALID_CONFIGURATION", `${name} is invalid`);
  }
  return value;
}

function principal(value: string, name: string): string {
  const parsed = configText(value, name, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(parsed)) {
    throw new BrokerError(500, "INVALID_CONFIGURATION", `${name} is invalid`);
  }
  return parsed;
}

function loopbackHost(value: string | undefined): string {
  const host = configText(value ?? "127.0.0.1", "host", 253);
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new BrokerError(
      500,
      "INVALID_CONFIGURATION",
      "Deployment broker HTTP must bind to a literal loopback address",
    );
  }
  return host;
}

export function normalizeConfig(options: DeploymentBrokerOptions): DeploymentBrokerConfig {
  const humanToken = configText(options.humanToken, "humanToken", 512);
  const handoffIssuerToken = configText(options.handoffIssuerToken, "handoffIssuerToken", 512);
  const executorToken = configText(options.executorToken, "executorToken", 512);
  if (
    humanToken.length < 32 ||
    handoffIssuerToken.length < 32 ||
    executorToken.length < 32 ||
    new Set([humanToken, handoffIssuerToken, executorToken]).size !== 3
  ) {
    throw new BrokerError(
      500,
      "INVALID_CONFIGURATION",
      "Handoff issuer, human, and executor tokens must be distinct and at least 32 characters",
    );
  }
  if (options.targetEnvironments.length < 1 || options.targetEnvironments.length > 32) {
    throw new BrokerError(500, "INVALID_CONFIGURATION", "targetEnvironments must contain 1 to 32 entries");
  }
  const environments = new Set<string>();
  for (const environment of options.targetEnvironments) {
    const parsed = principal(environment, "targetEnvironment");
    if (environments.has(parsed)) {
      throw new BrokerError(500, "INVALID_CONFIGURATION", "targetEnvironments contains a duplicate");
    }
    environments.add(parsed);
  }
  const minimumExpirySeconds = boundedInteger(options.minimumExpirySeconds, 15, 5, 300, "minimumExpirySeconds");
  const maximumExpirySeconds = boundedInteger(options.maximumExpirySeconds, 900, 30, 3_600, "maximumExpirySeconds");
  if (maximumExpirySeconds < minimumExpirySeconds) {
    throw new BrokerError(500, "INVALID_CONFIGURATION", "maximumExpirySeconds is below the minimum");
  }
  const host = loopbackHost(options.host);
  return Object.freeze({
    storePath: configText(options.storePath, "storePath", 4_096),
    humanToken,
    handoffIssuerToken,
    executorToken,
    humanPrincipal: principal(options.humanPrincipal, "humanPrincipal"),
    handoffIssuerPrincipal: principal(options.handoffIssuerPrincipal, "handoffIssuerPrincipal"),
    executorPrincipal: principal(options.executorPrincipal, "executorPrincipal"),
    targetEnvironments: environments,
    host,
    port: boundedInteger(options.port, 0, 0, 65_535, "port"),
    maxBodyBytes: boundedInteger(options.maxBodyBytes, 8_192, 512, 65_536, "maxBodyBytes"),
    maxTextLength: boundedInteger(options.maxTextLength, 128, 32, 1_024, "maxTextLength"),
    minimumExpirySeconds,
    maximumExpirySeconds,
    now: options.now ?? (() => new Date()),
  });
}
