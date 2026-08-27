import type { DocSource } from "./enumerate.js";

export function withSourceBanner(source: DocSource, repoName: string, shortSha: string): string {
  return `> **Read-only mirror.** Source: \`${repoName}/${source.path}\` @ ${shortSha}. Edit in the repository — this page is republished on merge. Comments are welcome here.\n\n${source.markdown}`;
}
