import { createHash, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { assertDisjointSupervisorDirectories } from "./config.js";

const SHA256_RE = /^[0-9a-f]{64}$/i;
const MAX_PROVIDER_MODULE_BYTES = 16 * 1024 * 1024;

export interface ProviderModuleVerification {
  modulePath: string;
  expectedSha256: string;
  workingDirectory?: string;
  stateDirectory?: string;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function canonicalProspectivePath(pathname: string): Promise<string> {
  const requested = resolve(pathname);
  let ancestor = requested;
  const suffix: string[] = [];
  while (true) {
    try {
      const canonical = await realpath(ancestor);
      return resolve(canonical, ...suffix.reverse());
    } catch (error) {
      if (!isMissing(error)) throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      suffix.push(ancestor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      ancestor = parent;
    }
  }
}

function pathInside(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return fromParent === "" || (
    fromParent !== ".." &&
    !fromParent.startsWith(`..${sep}`) &&
    !isAbsolute(fromParent)
  );
}

export function parseProviderModuleSha256(value: unknown): string {
  if (typeof value !== "string" || !SHA256_RE.test(value)) {
    throw new Error("Provider adapter SHA-256 must contain exactly 64 hexadecimal characters");
  }
  return value.toLowerCase();
}

/**
 * Verifies the credential-bearing adapter entrypoint before every host launch.
 * The entrypoint must live outside both agent-writable and supervisor-state
 * trees; linked or group/world-writable files are rejected.
 */
export async function verifyTrustedProviderModule(
  options: ProviderModuleVerification,
): Promise<void> {
  if (!isAbsolute(options.modulePath)) throw new Error("Provider adapter module path must be absolute");
  const requestedPath = resolve(options.modulePath);
  const expectedSha256 = parseProviderModuleSha256(options.expectedSha256);
  const canonicalPath = await realpath(requestedPath);
  if (canonicalPath !== requestedPath) {
    throw new Error("Provider adapter module path must not contain symbolic-link aliases");
  }
  if (options.workingDirectory) {
    const canonicalWorking = await canonicalProspectivePath(options.workingDirectory);
    if (pathInside(canonicalWorking, canonicalPath)) {
      throw new Error("Provider adapter module must be outside workingDirectory");
    }
  }
  if (options.stateDirectory) {
    const canonicalState = await canonicalProspectivePath(options.stateDirectory);
    if (pathInside(canonicalState, canonicalPath)) {
      throw new Error("Provider adapter module must be outside stateDirectory");
    }
    if (options.workingDirectory) {
      assertDisjointSupervisorDirectories(
        await canonicalProspectivePath(options.workingDirectory),
        canonicalState,
      );
    }
  }

  const handle = await open(canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < 1 || before.size > MAX_PROVIDER_MODULE_BYTES) {
      throw new Error("Provider adapter module must be a bounded regular file");
    }
    if ((before.mode & 0o022) !== 0) {
      throw new Error("Provider adapter module must not be group- or world-writable");
    }
    if (
      typeof process.getuid === "function" &&
      before.uid !== process.getuid() &&
      before.uid !== 0
    ) {
      throw new Error("Provider adapter module must be owned by the supervisor user or root");
    }
    const content = await handle.readFile();
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      throw new Error("Provider adapter module changed during integrity verification");
    }
    const actual = Buffer.from(createHash("sha256").update(content).digest("hex"), "ascii");
    const expected = Buffer.from(expectedSha256, "ascii");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("Provider adapter module SHA-256 does not match its configured integrity pin");
    }
  } finally {
    await handle.close();
  }
}
