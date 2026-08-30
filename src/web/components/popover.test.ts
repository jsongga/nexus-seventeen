import { createElement, createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Popover } from "./popover";

describe("Popover", () => {
  it("renders a named non-modal dialog with an initial-focus target", () => {
    const markup = renderToStaticMarkup(
      createElement(Popover, {
        open: true,
        onClose: vi.fn(),
        anchorRef: createRef<HTMLButtonElement>(),
        label: "Pause board",
        children: createElement("textarea", { "data-popover-initial-focus": true }),
      })
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-label="Pause board"');
    expect(markup).not.toContain("aria-modal");
    expect(markup).toContain('data-popover-initial-focus="true"');
    expect(markup).toContain("min-h-0 overflow-y-auto p-3");
  });
});
