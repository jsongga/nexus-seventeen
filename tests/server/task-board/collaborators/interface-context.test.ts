import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import {
  PUBLISHED_INTERFACE_CACHE_MAX_ENTRIES,
  PublishedInterfaceCache,
  readPublishedInterface,
} from "#server/task-board/collaborators/interface-context";
import type { GitRunner } from "#server/task-board/collaborators/scope-check";

const execFileAsync = promisify(execFile);
const FIRST_INTERFACE = "# Provider interface\n\n- `GET /v1/first`\n";
const SECOND_INTERFACE = "# Provider interface\n\n- `GET /v2/second`\n";

function interfaceGit(run: (arguments_: readonly string[]) => string | Buffer): GitRunner {
  const text = (arguments_: readonly string[]): string => {
    const result = run(arguments_);
    return typeof result === "string" ? result : result.toString("utf8");
  };
  return Object.assign(text, {
    bytes: (arguments_: readonly string[]): Buffer => {
      const result = run(arguments_);
      return typeof result === "string" ? Buffer.from(result, "utf8") : result;
    },
  });
}

async function git(repoPath: string, arguments_: readonly string[]): Promise<string> {
  const result = await execFileAsync("git", [...arguments_], {
    cwd: repoPath,
    encoding: "utf8",
  });
  return result.stdout;
}

async function interfaceRepository(): Promise<
  Readonly<{
    repoPath: string;
    absentSha: string;
    firstSha: string;
    secondSha: string;
    invalidUtf8Sha: string;
    oversizedSha: string;
    nonFileSha: string;
    symlinkSha: string;
  }>
> {
  const root = await mkdtemp(join(tmpdir(), "steward-interface-context-"));
  const repoPath = join(root, "provider");
  await mkdir(join(repoPath, "docs"), { recursive: true });
  await git(repoPath, ["init"]);
  await git(repoPath, ["config", "user.email", "interface-context@example.test"]);
  await git(repoPath, ["config", "user.name", "Interface Context Fixture"]);

  await writeFile(join(repoPath, "seed.txt"), "provider fixture\n", "utf8");
  await git(repoPath, ["add", "seed.txt"]);
  await git(repoPath, ["commit", "-m", "Seed provider"]);
  const absentSha = (await git(repoPath, ["rev-parse", "HEAD"])).trim();

  await writeFile(join(repoPath, "docs/interface.md"), FIRST_INTERFACE, "utf8");
  await git(repoPath, ["add", "docs/interface.md"]);
  await git(repoPath, ["commit", "-m", "Publish first interface"]);
  const firstSha = (await git(repoPath, ["rev-parse", "HEAD"])).trim();

  await writeFile(join(repoPath, "docs/interface.md"), SECOND_INTERFACE, "utf8");
  await git(repoPath, ["add", "docs/interface.md"]);
  await git(repoPath, ["commit", "-m", "Publish second interface"]);
  const secondSha = (await git(repoPath, ["rev-parse", "HEAD"])).trim();

  await writeFile(join(repoPath, "docs/interface.md"), Buffer.from([0x23, 0x20, 0xc3, 0x28, 0x0a]));
  await git(repoPath, ["add", "docs/interface.md"]);
  await git(repoPath, ["commit", "-m", "Publish malformed UTF-8 interface"]);
  const invalidUtf8Sha = (await git(repoPath, ["rev-parse", "HEAD"])).trim();

  await writeFile(join(repoPath, "docs/interface.md"), "x".repeat(64 * 1_024 + 1), "utf8");
  await git(repoPath, ["add", "docs/interface.md"]);
  await git(repoPath, ["commit", "-m", "Publish oversized interface"]);
  const oversizedSha = (await git(repoPath, ["rev-parse", "HEAD"])).trim();

  await rm(join(repoPath, "docs/interface.md"));
  await mkdir(join(repoPath, "docs/interface.md"));
  await writeFile(join(repoPath, "docs/interface.md", "nested.md"), "not the interface\n", "utf8");
  await git(repoPath, ["add", "docs/interface.md"]);
  await git(repoPath, ["commit", "-m", "Replace interface with a tree"]);
  const nonFileSha = (await git(repoPath, ["rev-parse", "HEAD"])).trim();

  await rm(join(repoPath, "docs/interface.md"), { recursive: true });
  await writeFile(join(repoPath, "interface-target.md"), "# Symlink target\n", "utf8");
  await symlink("../interface-target.md", join(repoPath, "docs/interface.md"));
  await git(repoPath, ["add", "docs/interface.md", "interface-target.md"]);
  await git(repoPath, ["commit", "-m", "Replace interface with a symlink"]);
  const symlinkSha = (await git(repoPath, ["rev-parse", "HEAD"])).trim();

  return Object.freeze({
    repoPath,
    absentSha,
    firstSha,
    secondSha,
    invalidUtf8Sha,
    oversizedSha,
    nonFileSha,
    symlinkSha,
  });
}

test("reads the published interface from a committed provider revision", async () => {
  const fixture = await interfaceRepository();

  assert.deepEqual(readPublishedInterface(fixture.repoPath, fixture.secondSha), {
    kind: "present",
    markdown: SECOND_INTERFACE,
  });
});

test("returns a typed absence when the published interface does not exist", async () => {
  const fixture = await interfaceRepository();

  assert.deepEqual(readPublishedInterface(fixture.repoPath, fixture.absentSha), {
    kind: "blocked",
    reason: "absent",
  });
});

test("rejects a published interface larger than 64 KiB", async () => {
  const fixture = await interfaceRepository();

  assert.deepEqual(readPublishedInterface(fixture.repoPath, fixture.oversizedSha), {
    kind: "blocked",
    reason: "too_large",
  });
});

test("reports a non-blob interface path as not a file", async () => {
  const fixture = await interfaceRepository();

  assert.deepEqual(readPublishedInterface(fixture.repoPath, fixture.nonFileSha), {
    kind: "blocked",
    reason: "not_file",
  });
});

test("reports a Git symlink interface path as not a file", async () => {
  const fixture = await interfaceRepository();

  assert.deepEqual(readPublishedInterface(fixture.repoPath, fixture.symlinkSha), {
    kind: "blocked",
    reason: "not_file",
  });
});

test("rejects a committed interface blob that is not valid UTF-8", async () => {
  const fixture = await interfaceRepository();

  assert.deepEqual(readPublishedInterface(fixture.repoPath, fixture.invalidUtf8Sha), {
    kind: "blocked",
    reason: "invalid_markdown",
    detail: "invalid_utf8",
  });
});

test("reads by the supplied SHA instead of the provider's current head", async () => {
  const fixture = await interfaceRepository();

  assert.deepEqual(readPublishedInterface(fixture.repoPath, fixture.firstSha), {
    kind: "present",
    markdown: FIRST_INTERFACE,
  });
  assert.deepEqual(readPublishedInterface(fixture.repoPath, fixture.secondSha), {
    kind: "present",
    markdown: SECOND_INTERFACE,
  });
});

test("bounds the blob with cat-file before reading it with show", () => {
  const calls: string[][] = [];
  const markdown = "# Published interface 😀 𠀀\n";
  const sha = "a".repeat(40);

  assert.deepEqual(
    readPublishedInterface(
      "/repos/provider",
      sha,
      undefined,
      interfaceGit((arguments_) => {
        calls.push([...arguments_]);
        if (arguments_.includes("ls-tree")) return `100644 blob ${"b".repeat(40)}\tdocs/interface.md\0`;
        if (arguments_.includes("cat-file")) return `${Buffer.byteLength(markdown, "utf8")}\n`;
        if (arguments_.includes("show")) return markdown;
        throw new Error(`unexpected git call: ${arguments_.join(" ")}`);
      })
    ),
    { kind: "present", markdown }
  );
  assert.deepEqual(
    calls.map((arguments_) =>
      arguments_.find((argument) => argument === "ls-tree" || argument === "cat-file" || argument === "show")
    ),
    ["ls-tree", "cat-file", "show"]
  );
});

test("does not invoke git show after cat-file reports an oversized blob", () => {
  const calls: string[][] = [];
  const sha = "a".repeat(40);

  assert.deepEqual(
    readPublishedInterface(
      "/repos/provider",
      sha,
      undefined,
      interfaceGit((arguments_) => {
        calls.push([...arguments_]);
        if (arguments_.includes("ls-tree")) return `100644 blob ${"b".repeat(40)}\tdocs/interface.md\0`;
        if (arguments_.includes("cat-file")) return `${64 * 1_024 + 1}\n`;
        throw new Error("show must not be called");
      })
    ),
    { kind: "blocked", reason: "too_large" }
  );
  assert.equal(
    calls.some((arguments_) => arguments_.includes("show")),
    false
  );
});

test("rejects controls and malformed surrogate bytes while preserving supplementary scalars", () => {
  const sha = "a".repeat(40);
  const read = (markdown: string | Buffer) =>
    readPublishedInterface(
      "/repos/provider",
      sha,
      undefined,
      interfaceGit((arguments_) => {
        if (arguments_.includes("ls-tree")) return `100644 blob ${"b".repeat(40)}\tdocs/interface.md\0`;
        if (arguments_.includes("cat-file"))
          return `${typeof markdown === "string" ? Buffer.byteLength(markdown, "utf8") : markdown.byteLength}\n`;
        if (arguments_.includes("show")) return markdown;
        throw new Error(`unexpected git call: ${arguments_.join(" ")}`);
      })
    );

  assert.deepEqual(read("emoji 😀 and CJK Ext-B 𠀀\n"), {
    kind: "present",
    markdown: "emoji 😀 and CJK Ext-B 𠀀\n",
  });
  assert.deepEqual(read("C1 \u0085 control\n"), {
    kind: "blocked",
    reason: "invalid_markdown",
    detail: "prohibited_characters",
  });
  assert.deepEqual(read(Buffer.from([0xed, 0xa0, 0x80])), {
    kind: "blocked",
    reason: "invalid_markdown",
    detail: "invalid_utf8",
  });
});

test("maps an ENOBUFS read failure to an availability result", () => {
  const sha = "a".repeat(40);
  const error = Object.assign(new Error("stdout maxBuffer exceeded"), { code: "ENOBUFS" });

  assert.deepEqual(
    readPublishedInterface(
      "/repos/provider",
      sha,
      undefined,
      interfaceGit((arguments_) => {
        if (arguments_.includes("ls-tree")) return `100644 blob ${"b".repeat(40)}\tdocs/interface.md\0`;
        if (arguments_.includes("cat-file")) return "12\n";
        if (arguments_.includes("show")) throw error;
        throw new Error(`unexpected git call: ${arguments_.join(" ")}`);
      })
    ),
    { kind: "blocked", reason: "too_large" }
  );
});

test("classifies an empty published interface as empty", () => {
  const sha = "a".repeat(40);

  assert.deepEqual(
    readPublishedInterface(
      "/repos/provider",
      sha,
      undefined,
      interfaceGit((arguments_) => {
        if (arguments_.includes("ls-tree")) return `100644 blob ${"b".repeat(40)}\tdocs/interface.md\0`;
        if (arguments_.includes("cat-file")) return "0\n";
        if (arguments_.includes("show")) return "";
        throw new Error(`unexpected git call: ${arguments_.join(" ")}`);
      })
    ),
    { kind: "blocked", reason: "empty", detail: "empty" }
  );
});

test("does not cache a transient read error", () => {
  const sha = "a".repeat(40);
  const markdown = "# Recovered interface\n";
  let treeReads = 0;
  const cache = new PublishedInterfaceCache(
    interfaceGit((arguments_) => {
      if (arguments_.includes("ls-tree")) {
        treeReads += 1;
        if (treeReads === 1) throw new Error("repository timeout");
        return `100644 blob ${"b".repeat(40)}\tdocs/interface.md\0`;
      }
      if (arguments_.includes("cat-file")) return `${Buffer.byteLength(markdown, "utf8")}\n`;
      if (arguments_.includes("show")) return markdown;
      throw new Error(`unexpected git call: ${arguments_.join(" ")}`);
    })
  );

  assert.deepEqual(cache.read("/repos/provider", sha), { kind: "blocked", reason: "read_error" });
  assert.deepEqual(cache.read("/repos/provider", sha), { kind: "present", markdown });
  assert.equal(treeReads, 2);
});

test("keys definitive cache entries by repository path as well as SHA and interface path", () => {
  const sha = "a".repeat(40);
  const cache = new PublishedInterfaceCache(
    interfaceGit((arguments_) => {
      const repoPath = arguments_[arguments_.indexOf("-C") + 1];
      const markdown =
        repoPath === "/repos/corrected-provider" ? "# Corrected provider interface\n" : "# Stale provider interface\n";
      if (arguments_.includes("ls-tree")) return `100644 blob ${"b".repeat(40)}\tdocs/interface.md\0`;
      if (arguments_.includes("cat-file")) return `${Buffer.byteLength(markdown, "utf8")}\n`;
      if (arguments_.includes("show")) return markdown;
      throw new Error(`unexpected git call: ${arguments_.join(" ")}`);
    })
  );

  assert.deepEqual(cache.read("/repos/stale-provider", sha), {
    kind: "present",
    markdown: "# Stale provider interface\n",
  });
  assert.deepEqual(cache.read("/repos/corrected-provider", sha), {
    kind: "present",
    markdown: "# Corrected provider interface\n",
  });
});

test("evicts one immutable interface entry after a claim-side repository read error", () => {
  const sha = "a".repeat(40);
  let markdown = "# Cached provider interface\n";
  let treeReads = 0;
  const cache = new PublishedInterfaceCache(
    interfaceGit((arguments_) => {
      if (arguments_.includes("ls-tree")) {
        treeReads += 1;
        return `100644 blob ${"b".repeat(40)}\tdocs/interface.md\0`;
      }
      if (arguments_.includes("cat-file")) return `${Buffer.byteLength(markdown, "utf8")}\n`;
      if (arguments_.includes("show")) return markdown;
      throw new Error(`unexpected git call: ${arguments_.join(" ")}`);
    })
  );

  assert.equal(cache.read("/repos/provider", sha).kind, "present");
  markdown = "# Recovered provider interface\n";
  cache.evict("/repos/provider", sha);
  assert.deepEqual(cache.read("/repos/provider", sha), { kind: "present", markdown });
  assert.equal(treeReads, 2);
});

test("bounds immutable published-interface entries with least-recently-used eviction", () => {
  let treeReads = 0;
  const cache = new PublishedInterfaceCache(
    interfaceGit((arguments_) => {
      if (arguments_.includes("ls-tree")) {
        treeReads += 1;
        return `100644 blob ${"b".repeat(40)}\tdocs/interface.md\0`;
      }
      if (arguments_.includes("cat-file")) return "12\n";
      if (arguments_.includes("show")) return "# Interface\n";
      throw new Error(`unexpected git call: ${arguments_.join(" ")}`);
    })
  );
  for (let index = 0; index < PUBLISHED_INTERFACE_CACHE_MAX_ENTRIES; index += 1) {
    assert.equal(cache.read(`/repos/provider-${index}`, "a".repeat(40)).kind, "present");
  }
  assert.equal(cache.read("/repos/provider-0", "a".repeat(40)).kind, "present");
  assert.equal(cache.read("/repos/provider-overflow", "a".repeat(40)).kind, "present");
  assert.equal(cache.read("/repos/provider-1", "a".repeat(40)).kind, "present");
  assert.equal(treeReads, PUBLISHED_INTERFACE_CACHE_MAX_ENTRIES + 2);
});
