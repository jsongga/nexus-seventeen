import { posix } from "node:path";

import type { VerifyRule } from "./contract.js";

export type VerifyTier = "fast" | "area";

export interface VerifySelection {
  readonly nodeTestFiles: readonly string[];
  readonly nodeTestDirs: readonly string[];
  readonly vitestTargets: readonly string[];
  readonly escalations: readonly string[];
  readonly unmatched: readonly string[];
}

export interface MappingHost {
  fileExists(path: string): boolean;
  directoryExists(path: string): boolean;
}

const REGEXP_SPECIAL_CHARACTERS = new Set(["\\", "^", "$", ".", "*", "+", "?", "(", ")", "[", "]", "{", "}", "|"]);

export function globToRegExp(glob: string): RegExp {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index] ?? "";
    if (character === "/" && glob[index + 1] === "*" && glob[index + 2] === "*" && index + 3 === glob.length) {
      pattern += "(?:/[^/]+)*";
      index += 2;
    } else if (character === "*" && glob[index + 1] === "*" && glob[index + 2] === "/") {
      pattern += "(?:[^/]+/)*";
      index += 2;
    } else if (character === "*" && glob[index + 1] === "*") {
      pattern += ".*";
      index += 1;
    } else if (character === "*") {
      pattern += "[^/]*";
    } else {
      pattern += REGEXP_SPECIAL_CHARACTERS.has(character) ? `\\${character}` : character;
    }
  }
  return new RegExp(`${pattern}$`, "u");
}

export function mapChangedFiles(
  changed: readonly string[],
  rules: readonly VerifyRule[],
  tier: VerifyTier,
  host: MappingHost
): VerifySelection {
  const nodeTestFiles = new Set<string>();
  const nodeTestDirs = new Set<string>();
  const vitestTargets = new Set<string>();
  const escalations = new Set<string>();
  const unmatched = new Set<string>();
  const matchers = rules.map((rule) => ({ rule, matcher: globToRegExp(rule.match) }));

  for (const file of changed) {
    const matched = matchers.find(({ matcher }) => matcher.test(file));
    if (matched === undefined) {
      unmatched.add(file);
      continue;
    }

    const { action } = matched.rule;
    switch (action.kind) {
      case "self":
        if (tier === "fast") nodeTestFiles.add(file);
        else nodeTestDirs.add(posix.dirname(file));
        break;

      case "mirror": {
        const testFile = file.replace(/^src\//u, "tests/").replace(/\.ts$/u, ".test.ts");
        const testDir = posix.dirname(testFile);
        if (tier === "fast" && host.fileExists(testFile)) {
          nodeTestFiles.add(testFile);
        } else if (host.directoryExists(testDir)) {
          nodeTestDirs.add(testDir);
        } else {
          escalations.add(`${file} (no mirror test or directory)`);
        }
        break;
      }

      case "fixed":
        for (const testDir of action.nodeTestDirs ?? []) {
          if (host.directoryExists(testDir)) nodeTestDirs.add(testDir);
          else escalations.add(`${file} (configured test dir missing)`);
        }
        for (const target of action.vitest ?? []) vitestTargets.add(target);
        break;

      case "colocated": {
        if (tier === "area") {
          vitestTargets.add(action.vitestFallback);
          break;
        }
        const isTestFile = /\.test\.tsx?$/u.test(file);
        const testFile = isTestFile ? file : /\.tsx?$/u.test(file) ? file.replace(/(\.tsx?)$/u, ".test$1") : undefined;
        if (testFile !== undefined && (isTestFile || host.fileExists(testFile))) vitestTargets.add(testFile);
        else vitestTargets.add(action.vitestFallback);
        break;
      }

      case "none":
        break;

      case "escalate":
        escalations.add(`${file} (rule ${matched.rule.match} escalates)`);
        break;
    }
  }

  return {
    nodeTestFiles: [...nodeTestFiles].sort(),
    nodeTestDirs: [...nodeTestDirs].sort(),
    vitestTargets: [...vitestTargets].sort(),
    escalations: [...escalations].sort(),
    unmatched: [...unmatched].sort(),
  };
}
