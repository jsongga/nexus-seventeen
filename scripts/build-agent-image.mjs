import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AGENT_IMAGE_REPOSITORY, computeAgentImageTag } from "../build/server/agents/task-container/image-tag.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tag = await computeAgentImageTag(root);
const image = `${AGENT_IMAGE_REPOSITORY}:${tag}`;

try {
  execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
  console.log(`agent image up to date: ${image}`);
  process.exit(0);
} catch {
  // fall through to build
}

const version = (pkg) => execFileSync("npm", ["view", pkg, "version"], { encoding: "utf8" }).trim();
const codexVersion = version("@openai/codex");
const claudeVersion = version("@anthropic-ai/claude-code");
console.log(`building ${image} (codex ${codexVersion}, claude ${claudeVersion})`);
execFileSync(
  "docker",
  [
    "build",
    "--target",
    "agent",
    "--build-arg",
    `CODEX_CLI_VERSION=${codexVersion}`,
    "--build-arg",
    `CLAUDE_CLI_VERSION=${claudeVersion}`,
    "-t",
    image,
    root,
  ],
  { stdio: "inherit" }
);
