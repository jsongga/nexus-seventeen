/** Verifies repository management labels, paths, and local list updates. */

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskBoardClient } from "../../data/client";
import type { BoardRepository } from "../../types";
import { ProjectRepositories, isAbsoluteRepositoryPath } from "./ProjectRepositories";

const repositories: BoardRepository[] = [
  {
    id: "repository-primary",
    projectId: "project-one",
    name: "Platform API",
    path: "/repos/platform-api",
    isPrimary: true,
    version: 3,
  },
  {
    id: "repository-consumer",
    projectId: "project-one",
    name: "Consumer app",
    path: "/repos/consumer-app",
    isPrimary: false,
    version: 1,
  },
];

afterEach(() => vi.unstubAllGlobals());

function renderRepositories(): string {
  return renderToStaticMarkup(
    createElement(ProjectRepositories, {
      projectId: "project-one",
      repositories,
      client: {} as TaskBoardClient,
      connected: true,
      busy: false,
      onMutation: vi.fn(),
    })
  );
}

describe("project repository surface", () => {
  it("shows names, absolute paths, the primary marker, and all three supported actions", () => {
    const markup = renderRepositories();

    for (const text of [
      "Platform API",
      "/repos/platform-api",
      "Consumer app",
      "/repos/consumer-app",
      "Primary",
      "Add repository",
      "Rename",
      "Re-point",
      "Repository paths must be absolute and begin with /.",
      "inherits the primary repository",
    ])
      expect(markup).toContain(text);
    expect(markup).not.toContain("Make primary");
  });

  it("starts collapsed below md and open at the desktop breakpoint", () => {
    vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
    const mobileMarkup = renderRepositories();
    const mobileOpeningTag = mobileMarkup.slice(0, mobileMarkup.indexOf(">"));
    expect(mobileOpeningTag).not.toContain("open=");

    vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
    const desktopMarkup = renderRepositories();
    const desktopOpeningTag = desktopMarkup.slice(0, desktopMarkup.indexOf(">"));
    expect(desktopOpeningTag).toContain('open=""');
  });

  it("recognizes only absolute repository paths", () => {
    expect(isAbsoluteRepositoryPath(" /repos/platform ")).toBe(true);
    expect(isAbsoluteRepositoryPath("repos/platform")).toBe(false);
    expect(isAbsoluteRepositoryPath("   ")).toBe(false);
  });
});
