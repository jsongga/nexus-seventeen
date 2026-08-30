import assert from "node:assert/strict";
import test from "node:test";
import { withSourceBanner } from "../../../src/server/docs-publish/banner.js";

test("prepends the source banner byte-exactly and leaves markdown unchanged", () => {
  const result = withSourceBanner(
    {
      path: "docs/workflow.md",
      title: "docs/workflow.md",
      markdown: "# Workflow\n\nBody.\n",
      blobSha: "0123456789abcdef0123456789abcdef01234567",
    },
    "nexus-seventeen"
  );

  assert.equal(
    result,
    "> **Read-only mirror.** Source: `nexus-seventeen/docs/workflow.md` @ blob 0123456789ab. Edit in the repository — this page is republished on merge. Comments are welcome here.\n\n# Workflow\n\nBody.\n"
  );
});
