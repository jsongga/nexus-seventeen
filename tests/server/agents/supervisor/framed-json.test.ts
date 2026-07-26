import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import {
  FramedJsonProtocolError,
  FramedJsonReader,
  FramedJsonWriter,
} from "#server/agents/supervisor/framed-json";

test("framed provider transport rejects declared and outbound oversize messages", async () => {
  const inbound = new PassThrough();
  const reader = new FramedJsonReader(inbound, 1_024);
  const invalidHeader = Buffer.alloc(4);
  invalidHeader.writeUInt32BE(1_025);
  inbound.write(invalidHeader);
  await assert.rejects(
    reader.next(),
    (error: unknown) => error instanceof FramedJsonProtocolError,
  );

  const outbound = new PassThrough();
  outbound.resume();
  const writer = new FramedJsonWriter(outbound, 1_024);
  await assert.rejects(
    writer.send({ payload: "x".repeat(1_100) }),
    (error: unknown) => error instanceof FramedJsonProtocolError,
  );
  await writer.close();
});

test("framed provider transport fails closed on a truncated final frame", async () => {
  const transport = new PassThrough();
  const reader = new FramedJsonReader(transport, 1_024);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(20);
  transport.end(Buffer.concat([header, Buffer.from("{}") ]));
  await assert.rejects(
    reader.next(),
    (error: unknown) => error instanceof FramedJsonProtocolError,
  );
});
