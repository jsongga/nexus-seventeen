import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AGENT_IMAGE_REPOSITORY, computeAgentImageTag } from "../build/server/agents/task-container/image-tag.js";

const provider = process.argv[2];
if (provider !== "codex" && provider !== "claude") throw new Error("Usage: node scripts/agent-container-smoke.mjs codex|claude");
const key = provider === "codex" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
if (!process.env[key]) throw new Error(`${key} must be set for the smoke run`);
const root = fileURLToPath(new URL("..", import.meta.url));
const image = `${AGENT_IMAGE_REPOSITORY}:${await computeAgentImageTag(root)}`;
// Infrastructure (networks + proxy) must already exist — run npm run test:container once first, or any container lane.
const output = execFileSync("docker", [
  "run", "--rm", "-i", "--network", "steward-agents", "--user", "node", "--cap-drop", "ALL",
  "-e", "HTTPS_PROXY=http://steward-egress-proxy:3128", "-e", "HTTP_PROXY=http://steward-egress-proxy:3128",
  "-e", "NODE_USE_ENV_PROXY=1", "-e", key,
  image,
  ...(provider === "codex"
    ? ["codex", "exec", "--ephemeral", "--skip-git-repo-check", "--model", "gpt-5-codex", "-"]
    : ["claude", "--print", "--model", "claude-haiku-4-5-20251001"]),
], { input: "Reply with the single word: reachable", encoding: "utf8", stdio: ["pipe", "pipe", "inherit"] });
console.log(output);
console.log(`smoke ${provider}: model API reachable through the egress proxy, proxy env honored`);
