import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DeploymentGrantBroker } from "./broker.js";
import type { DeploymentBrokerConfig, DeploymentBrokerOptions } from "./config.js";
import { normalizeConfig } from "./config.js";
import { BrokerError } from "./errors.js";
import {
  readJsonBody,
  requireExecutor,
  requireHandoffIssuer,
  requireHuman,
  sendError,
  sendJson,
} from "./http.js";
import {
  parseConsumeGrantRequest,
  parseCreateGrantRequest,
  parseIdempotencyKey,
  parseRegisterManagerHandoffRequest,
} from "./schema.js";

export interface BrokerAddress {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

function routeUrl(requestUrl: string | undefined): URL {
  try {
    return new URL(requestUrl ?? "", "http://deployment-broker.invalid");
  } catch {
    throw new BrokerError(400, "INVALID_REQUEST", "Request URL is invalid");
  }
}

export class DeploymentBrokerService {
  readonly #config: DeploymentBrokerConfig;
  readonly #broker: DeploymentGrantBroker;
  readonly #server: Server;
  #started = false;

  private constructor(config: DeploymentBrokerConfig, broker: DeploymentGrantBroker) {
    this.#config = config;
    this.#broker = broker;
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => sendError(response, error));
    });
    this.#server.requestTimeout = 15_000;
    this.#server.headersTimeout = 10_000;
    this.#server.maxHeadersCount = 32;
  }

  static async create(options: DeploymentBrokerOptions): Promise<DeploymentBrokerService> {
    const config = normalizeConfig(options);
    const broker = await DeploymentGrantBroker.open(config);
    return new DeploymentBrokerService(config, broker);
  }

  async #handle(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse): Promise<void> {
    const url = routeUrl(request.url);
    if (url.search.length > 0) throw new BrokerError(400, "INVALID_REQUEST", "Query parameters are not accepted");

    if (url.pathname === "/v1/manager-handoffs") {
      if (request.method !== "POST") throw new BrokerError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed");
      requireHandoffIssuer(request, this.#config);
      const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
      const input = parseRegisterManagerHandoffRequest(
        await readJsonBody(request, this.#config.maxBodyBytes),
        this.#config,
      );
      const result = await this.#broker.registerManagerHandoff(input, idempotencyKey);
      sendJson(response, result.duplicate ? 200 : 201, result);
      return;
    }

    if (url.pathname === "/v1/deployment-grants") {
      if (request.method !== "POST") throw new BrokerError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed");
      requireHuman(request, this.#config);
      const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
      const input = parseCreateGrantRequest(await readJsonBody(request, this.#config.maxBodyBytes), this.#config);
      const result = await this.#broker.createGrant(input, idempotencyKey);
      sendJson(response, result.duplicate ? 200 : 201, result);
      return;
    }

    const consumeMatch = /^\/v1\/deployment-grants\/([0-9a-f-]{36})\/consume$/u.exec(url.pathname);
    if (consumeMatch !== null) {
      if (request.method !== "POST") throw new BrokerError(405, "METHOD_NOT_ALLOWED", "Only POST is allowed");
      requireExecutor(request, this.#config);
      const idempotencyKey = parseIdempotencyKey(request.headers["idempotency-key"]);
      const input = parseConsumeGrantRequest(await readJsonBody(request, this.#config.maxBodyBytes), this.#config);
      const result = await this.#broker.consumeGrant(consumeMatch[1]!, input, idempotencyKey);
      sendJson(response, 200, result);
      return;
    }

    throw new BrokerError(404, "NOT_FOUND", "Endpoint was not found");
  }

  async start(): Promise<BrokerAddress> {
    if (this.#started) throw new Error("DEPLOYMENT_BROKER_ALREADY_STARTED");
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#server.once("error", onError);
      this.#server.listen(this.#config.port, this.#config.host, () => {
        this.#server.off("error", onError);
        resolve();
      });
    });
    this.#started = true;
    const address = this.#server.address() as AddressInfo;
    const displayHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
    return Object.freeze({ host: address.address, port: address.port, url: `http://${displayHost}:${address.port}` });
  }

  async close(): Promise<void> {
    if (this.#started) {
      await new Promise<void>((resolve, reject) => this.#server.close((error) => error === undefined ? resolve() : reject(error)));
      this.#started = false;
    }
    await this.#broker.close();
  }
}

export async function createDeploymentBroker(options: DeploymentBrokerOptions): Promise<DeploymentBrokerService> {
  return DeploymentBrokerService.create(options);
}
