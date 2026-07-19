import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export class SerialExecutor {
  #tail: Promise<void> = Promise.resolve();

  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(operation, operation);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  idle(): Promise<void> {
    return this.#tail;
  }
}

async function fsyncDirectory(pathname: string): Promise<void> {
  const directory = await open(pathname, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

export async function atomicWriteFile(pathname: string, content: string, mode = 0o600): Promise<void> {
  const directoryPath = dirname(pathname);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const temporaryPath = join(directoryPath, `.${basename(pathname)}.${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, "wx", mode);
  let renamed = false;
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, pathname);
    renamed = true;
    await fsyncDirectory(directoryPath);
  } finally {
    await handle.close().catch(() => undefined);
    if (!renamed) await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function appendAndFsync(pathname: string, content: string): Promise<void> {
  await mkdir(dirname(pathname), { recursive: true, mode: 0o700 });
  const handle = await open(pathname, "a", 0o600);
  try {
    const preAppendSize = (await handle.stat()).size;
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } catch (error) {
      try {
        await handle.truncate(preAppendSize);
        await handle.sync();
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          "APPEND_AND_ROLLBACK_FAILED",
        );
      }
      throw error;
    }
  } finally {
    await handle.close();
  }
}
