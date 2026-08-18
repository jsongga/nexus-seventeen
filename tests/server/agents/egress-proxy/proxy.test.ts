import assert from "node:assert/strict";
import { connect, createServer as createTcpServer, type AddressInfo } from "node:net";
import test from "node:test";
import { startEgressProxy } from "#server/agents/egress-proxy/proxy";

function tcpEcho(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createTcpServer((socket) => socket.pipe(socket));
    server.listen(0, "127.0.0.1", () => resolve({
      port: (server.address() as AddressInfo).port,
      close: () => server.close(),
    }));
  });
}

function connectThrough(proxyPort: number, target: string): Promise<{ head: string; socket: ReturnType<typeof connect> }> {
  return new Promise((resolve, reject) => {
    const socket = connect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nhost: ${target}\r\n\r\n`);
    });
    socket.once("data", (chunk) => resolve({ head: chunk.toString("utf8"), socket }));
    socket.once("error", reject);
  });
}

test("allows CONNECT to an allowlisted host:port and relays bytes", async () => {
  const echo = await tcpEcho();
  const proxy = await startEgressProxy({ host: "127.0.0.1", port: 0, allowedHosts: ["localhost"], allowedPorts: [echo.port] });
  try {
    const { head, socket } = await connectThrough(proxy.port, `localhost:${echo.port}`);
    assert.match(head, /^HTTP\/1\.1 200/u);
    const reply = await new Promise<string>((resolve) => {
      socket.once("data", (chunk) => resolve(chunk.toString("utf8")));
      socket.write("ping");
    });
    assert.equal(reply, "ping");
    socket.destroy();
  } finally {
    await proxy.close();
    echo.close();
  }
});

test("refuses non-allowlisted hosts, non-allowlisted ports, and non-CONNECT requests", async () => {
  const echo = await tcpEcho();
  const proxy = await startEgressProxy({ host: "127.0.0.1", port: 0, allowedHosts: ["localhost"], allowedPorts: [echo.port] });
  try {
    assert.match((await connectThrough(proxy.port, "evil.example:443")).head, /^HTTP\/1\.1 403/u);
    assert.match((await connectThrough(proxy.port, `localhost:${echo.port + 1}`)).head, /^HTTP\/1\.1 403/u);
    const plain = await fetch(`http://127.0.0.1:${proxy.port}/anything`).catch(() => null);
    assert.equal(plain?.status, 405);
  } finally {
    await proxy.close();
    echo.close();
  }
});

test("rejects an invalid allowlist entry at startup", async () => {
  await assert.rejects(
    startEgressProxy({ host: "127.0.0.1", port: 0, allowedHosts: ["Bad Host!"] }),
    /allowlist entry is invalid/u,
  );
});
