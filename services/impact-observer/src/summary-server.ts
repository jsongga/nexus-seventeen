import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { WorkspaceId } from "@cicada/steward-protocol";
import { ImpactObserver } from "./observer.js";

export interface ImpactSummaryServerAddress {
  readonly host: string;
  readonly port: number;
  readonly url: string;
}

function tokenMatches(expected: string, provided: string | undefined): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(provided ?? "");
  if (left.length !== right.length) {
    timingSafeEqual(left, Buffer.alloc(left.length));
    return false;
  }
  return timingSafeEqual(left, right);
}

function bearer(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  return header?.startsWith("Bearer ") ? header.slice(7) : undefined;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", Buffer.byteLength(body));
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(body);
}

export class ImpactSummaryServer {
  readonly #observer: ImpactObserver;
  readonly #workspaceId: WorkspaceId;
  readonly #outputToken: string;
  readonly #host: string;
  readonly #port: number;
  readonly #corsOrigins: ReadonlySet<string>;
  readonly #server: Server;

  constructor(options: {
    readonly observer: ImpactObserver;
    readonly workspaceId: WorkspaceId;
    readonly outputToken: string;
    readonly host: string;
    readonly port: number;
    readonly corsOrigins: ReadonlySet<string>;
  }) {
    this.#observer = options.observer;
    this.#workspaceId = options.workspaceId;
    this.#outputToken = options.outputToken;
    this.#host = options.host;
    this.#port = options.port;
    this.#corsOrigins = options.corsOrigins;
    this.#server = createServer((request, response) => this.#handle(request, response));
  }

  async start(): Promise<ImpactSummaryServerAddress> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(this.#port, this.#host, () => {
        this.#server.removeListener("error", reject);
        resolve();
      });
    });
    const address = this.#server.address() as AddressInfo;
    const host = address.address;
    const urlHost = host.includes(":") ? `[${host}]` : host;
    return Object.freeze({ host, port: address.port, url: `http://${urlHost}:${address.port}` });
  }

  async close(): Promise<void> {
    if (!this.#server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.#server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }

  #applyCors(request: IncomingMessage, response: ServerResponse): boolean {
    const origin = request.headers.origin;
    if (origin === undefined) return true;
    if (!this.#corsOrigins.has(origin)) {
      sendJson(response, 403, { error: { code: "ORIGIN_NOT_ALLOWED" } });
      return false;
    }
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
    return true;
  }

  #handle(request: IncomingMessage, response: ServerResponse): void {
    if (!this.#applyCors(request, response)) return;
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      response.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Authorization");
      response.setHeader("Access-Control-Max-Age", "600");
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    if (url.pathname === "/health" && request.method === "GET") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (!["/v1/impact-summaries", "/v1/impact-routing"].includes(url.pathname)) {
      sendJson(response, 404, { error: { code: "NOT_FOUND" } });
      return;
    }
    if (request.method !== "GET") {
      response.setHeader("Allow", "GET, OPTIONS");
      sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED" } });
      request.resume();
      return;
    }
    if (!tokenMatches(this.#outputToken, bearer(request))) {
      sendJson(response, 401, { error: { code: "UNAUTHORIZED" } });
      return;
    }
    if (url.searchParams.get("workspaceId") !== this.#workspaceId) {
      sendJson(response, 404, { error: { code: "WORKSPACE_NOT_FOUND" } });
      return;
    }
    sendJson(
      response,
      200,
      url.pathname === "/v1/impact-routing"
        ? this.#observer.routingSnapshot()
        : this.#observer.snapshot(),
    );
  }
}
