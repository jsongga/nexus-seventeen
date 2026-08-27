import type { DocSource } from "./enumerate.js";

export function withSourceBanner(source: DocSource, repoName: string): string {
  return `> **Read-only mirror.** Source: \`${repoName}/${source.path}\` @ ${source.blobSha.slice(0, 12)}. Edit in the repository — this page is republished on merge. Comments are welcome here.\n\n${source.markdown}`;
}
