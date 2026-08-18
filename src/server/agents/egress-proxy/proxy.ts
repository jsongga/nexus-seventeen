import { createServer } from "node:http";
import { connect } from "node:net";

export interface EgressProxyOptions {
  readonly host: string;
  readonly port: number;
  readonly allowedHosts: readonly string[];
  readonly allowedPorts?: readonly number[];
}

export interface EgressProxy {
  readonly port: number;
  close(): Promise<void>;
}

const DEFAULT_ALLOWED_PORTS = Object.freeze([443]);
const HOSTNAME = /^[a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?$/u;

export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const allowedHosts = new Set(options.allowedHosts.map((host) => {
    if (!HOSTNAME.test(host)) throw new Error(`Egress allowlist entry is invalid: ${host}`);
    return host;
  }));
  const allowedPorts = new Set((options.allowedPorts ?? DEFAULT_ALLOWED_PORTS).map((port) => {
    if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
      throw new Error(`Egress allowed port is invalid: ${port}`);
    }
    return port;
  }));
  const server = createServer((_request, response) => {
    response.writeHead(405, { connection: "close" }).end();
  });
  server.on("connect", (request, clientSocket, head) => {
    const target = request.url ?? "";
    const match = /^([a-z0-9.-]+):(\d{1,5})$/u.exec(target.toLowerCase());
    const host = match?.[1];
    const port = match === null ? null : Number(match[2]);
    if (host === undefined || port === null || !allowedHosts.has(host) || !allowedPorts.has(port)) {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n");
      return;
    }
    const upstream = connect(port, host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    const drop = () => {
      upstream.destroy();
      clientSocket.destroy();
    };
    upstream.on("error", drop);
    clientSocket.on("error", drop);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Egress proxy failed to bind"));
        return;
      }
      resolve(Object.freeze({
        port: address.port,
        close: () => new Promise<void>((done, fail) => server.close((error) => (error ? fail(error) : done()))),
      }));
    });
  });
}
