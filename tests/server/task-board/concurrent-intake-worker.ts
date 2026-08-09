import { parentPort, workerData } from "node:worker_threads";
import type { CreateWorkItemRequest } from "#shared/task-board-contract";
import { TaskBoard } from "#server/task-board";
import { config } from "./helpers.js";

interface ConcurrentIntakeWorkerData {
  readonly control: SharedArrayBuffer;
  readonly dbPath: string;
  readonly idempotencyKey: string;
  readonly request: CreateWorkItemRequest;
}

const data = workerData as ConcurrentIntakeWorkerData;
const control = new Int32Array(data.control);
const board = await TaskBoard.open(config(data.dbPath));
try {
  Atomics.add(control, 0, 1);
  parentPort?.postMessage({ type: "ready" });
  Atomics.wait(control, 1, 0);
  const result = board.createWorkItemAndStartPlanning(data.request, data.idempotencyKey);
  parentPort?.postMessage({ type: "complete", state: result.workItem.state });
} catch (error) {
  parentPort?.postMessage({ type: "error", message: error instanceof Error ? error.stack ?? error.message : String(error) });
} finally {
  board.close();
  parentPort?.close();
}
