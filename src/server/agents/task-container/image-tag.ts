import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

export const AGENT_IMAGE_REPOSITORY = "steward-agent";

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? listFiles(path) : entry.isFile() ? [path] : [];
    })
  );
  return files.flat();
}

export async function computeAgentImageTag(rootDirectory: string): Promise<string> {
  const hash = createHash("sha256");
  const root = resolve(rootDirectory);
  const agentDir = join(root, "docker_image", "agent");
  const files = [
    join(root, "package-lock.json"),
    join(root, "Dockerfile"),
    ...(await readdir(agentDir)).sort().map((name) => join(agentDir, name)),
    ...(await listFiles(join(root, "src", "server"))),
    ...(await listFiles(join(root, "src", "shared"))),
    join(root, "tsconfig.runtime.json"),
  ].sort();
  for (const file of files) {
    hash.update(relative(root, file));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}
