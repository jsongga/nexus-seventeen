#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const mode = process.env.STEWARD_STUB_MODE ?? "success";
  if (mode === "hang") return; // never exits; the launcher's timeout/stop path reaps it
  if (mode === "fail") process.exit(2);
  if (mode === "invalid") {
    process.stdout.write("this is not a codex event stream\n");
    process.exit(0);
  }
  const git = (...args) => execFileSync("git", ["-c", "user.name=steward-stub", "-c", "user.email=stub@steward.local", ...args], { stdio: "pipe" });
  writeFileSync("stub-proof.txt", `stub ran with ${input.length} prompt bytes\n`);
  git("add", "stub-proof.txt");
  git("commit", "-m", "stub: proof of containerized workspace execution");
  const result = {
    status: "completed",
    progress: ["Stub executed inside the task container."],
    result: "Stub committed stub-proof.txt on the task branch.",
    proposedChildTasks: [],
    expectedAgentMinutes: null,
    phases: [],
    humanQuestion: null,
    handoff: null,
    workflowPlan: null,
    detail: "Deterministic stub run for container execution tests.",
  };
  process.stdout.write(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }) + "\n");
  process.stdout.write(JSON.stringify({ type: "turn.completed" }) + "\n");
});
