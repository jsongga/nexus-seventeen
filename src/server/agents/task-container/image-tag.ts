import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

export const AGENT_IMAGE_REPOSITORY = "steward-agent";

export async function computeAgentImageTag(rootDirectory: string): Promise<string> {
  const hash = createHash("sha256");
  const agentDir = join(rootDirectory, "deploy", "agent");
  const files = [
    join(rootDirectory, "package-lock.json"),
    join(rootDirectory, "Dockerfile"),
    ...(await readdir(agentDir)).sort().map((name) => join(agentDir, name)),
  ];
  for (const file of files) {
    hash.update(file.slice(rootDirectory.length));
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 12);
}
