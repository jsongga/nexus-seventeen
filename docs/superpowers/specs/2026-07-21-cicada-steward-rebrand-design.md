# Cicada Steward — Brand Redesign

**Status** — Approved (design), pre-implementation · **Author** — John Song + Claude · **Date** — 2026-07-21 · **Scope** — Presentation-layer rebrand of the `steward/` React app to Cicada's canonical brand. Light-first, dark structured-in. **No behavioral or logic changes.**

## Summary

Cicada Steward already runs an **earlier snapshot** of the Cicada brand — same Manrope/DM Mono type, same ink `#171c24`, same teal family, and a **byte-identical logo mark**. This redesign migrates it one generation forward to the current brand law and applies that law's *discipline*, so it reads as a genuine redesign rather than a recolor.

- **Mechanically** — rewrite the design tokens and replace the inline hardcoded hexes scattered through `ui.tsx`, `AppShell.tsx`, and the 7 views with token utilities.
- **Visually** — warm-paper surfaces, AA-correct teal-on-light, teal reserved for "measured & normal" status, severity shown as glyph+color, tighter type hierarchy, soft layered shadows.
- **Structurally** — adopt the shadcn `:root`/`.dark`/`@theme inline` token pattern so a later dark-mode toggle is a class flip, not a rewrite.

## Brand source (authority)

The canonical brand lives in **`~/WebstormProjects/cicada-website`** (repo `landing-website`): `docs/DESIGN-SYSTEM.md` is the company-wide law; `src/app/globals.css` is the most-evolved token implementation. Traps confirmed and rejected: `cicada-shadcn-proto` (off-brand — Plus Jakarta Sans, boilerplate purple favicon) and `cicada-fleet` (deliberately off-brand indigo internal tool). Clone token values from the website's `globals.css`; treat `DESIGN-SYSTEM.md` as law.

## Token architecture

Adopt the website's Tailwind-v4 + shadcn pattern in `steward/src/styles.css`:

- Raw CSS vars in **`:root`** (light) and **`.dark`** (dark).
- An **`@theme inline`** block maps them to Tailwind utilities (`--color-background: var(--background)`), so `bg-background`, `text-ink`, etc. resolve per-mode.
- Keep existing semantic utility names in use today (`canvas`, `ink`, `muted`, `line`, `teal-soft`, `teal-500/700`, `caution*`, `urgent*`) as mapped aliases so downstream churn stays mechanical, **and** add the shadcn vocabulary (`card`, `popover`, `secondary`, `accent`, `border`, `input`, `ring`, `chart-1..5`, `sidebar*`).

**Canonical values (from `cicada-website/globals.css`):**

| Role | Light | Dark |
|---|---|---|
| canvas / background | `#eae9e4` warm paper | `#171c24` |
| card surface | `#f6f5f1` | `#1b212b` |
| popover / input / modal | `#ffffff` | `#1b212b` |
| foreground (ink) | `#171c24` | `#f3f3f3` |
| primary (teal fill) | `#41bbb0`, **fg `#171c24` — ink, never white** | `#41bbb0`, fg `#171c24` |
| teal-300 (text/icon on dark) | `#7fe0d6` | `#7fe0d6` |
| teal-500 (fills/marks) | `#41bbb0` | `#41bbb0` |
| teal-700 (text on light) | `#1b655d` *(was `#237a72`)* | `#7fe0d6` |
| accent wash | `rgba(65,187,176,.12)` | `rgba(65,187,176,.16)` |
| muted-foreground | `#57595f` | `#9aa4b2` |
| secondary | `#e6e5df` | `#232b36` |
| border | `#d9d8d1` | `#28323f` |
| input border | `#e4e7ea` | `#28323f` |
| ring | `#1b655d` | `#7fe0d6` |
| destructive/urgent | text `#a01c14`, fill `#7d1710`/white | fill `#7d1710`/white |
| caution/amber | fill `#f0b429`, text `#8a5d0a` | text `#e8b04b` |
| charts 1–5 | `#41bbb0 · #237a72 · #7fe0d6 · #f0b429 · #8a5d0a` | `#41bbb0 · #7fe0d6 · #237a72 · #f0b429 · #f3f3f3` |
| sidebar | bg `#ffffff`, primary `#41bbb0`/ink, accent-fg `#237a72`, border `#e4e7ea` | (dark equivalents) |

Also: `--radius: 0.7rem` with the sm(.6×)→4xl(2.6×) scale; `index.html` `theme-color` `#f3f3f3` → `#eae9e4`; `manifest.webmanifest` theme/background colors updated to match.

## Visual language (the reinterpretation)

- **Teal = "measured & normal" only.** Neutral ink/paper carries the UI; teal marks healthy/live/on-track status — not a generic accent or generic success.
- **Severity is never color-alone** — pair with a glyph: circle = normal, triangle = caution, diamond = urgent. Applies to attention/approval badges and run states.
- **Type** — keep Manrope (display+body, never Inter) / DM Mono (all numerals, IDs, timestamps, durations — tabular so timers don't jitter). Tighter display hierarchy (`tracking-[-0.02em]`, heavier headings). **No Instrument Serif** (flagged a brand liability; this is a declarative operator console).
- **Surfaces & shadows** — cards on warm `card` surface with soft, wide, low-opacity layered shadows; radii on the `0.7rem` scale.
- **Honesty rules** — no decorative pulsing "LIVE" dots (motion only when data moves), no fabricated numbers, respect `prefers-reduced-motion`.

## Surface-by-surface treatment

- **Shell (`AppShell.tsx`)** — warm sidebar; workspace switcher + panels on `card`; active nav = `accent` wash + `teal-700` text + inset teal bar (tokenized); the "Release simulation" panel stays ink `#171c24` as an intentional dark anchor; mobile header/bottom-nav/"More" sheet tokenized; attention badge → glyph+color.
- **Shared primitives (`ui.tsx`)** — `Button`×5, `Card`, `Pill`×7, `Avatar`, `ProgressBar`, `SectionHeading`, `Modal`, `inputClass`: every inline hex → token; `Card` gets warm surface + soft layered shadow; primary `Button` keeps ink-on-teal. Retokenizing here propagates to all views.
- **Views** — Overview/Attention, Missions, Runs, Approvals, Team, Routing, Audit: warm surfaces, teal-as-status, glyph+color severity, DM Mono numerals, `0.7rem` radii.
- **Heavy components** — `RunInspector`, `ApprovalDrawer`, `DecisionModals`, `ImpactSummaryCard`, `ApprovalCard`, `AgentQueueModal`: same treatment; live/normal = teal, questions/interrupts/failures = caution/urgent glyphs.

## Non-goals

- No changes to logic, data flow, routing, state, or interactions.
- No new features, no dark-mode **toggle UI** this pass (tokens are structured for it; wiring the switch is a follow-up).
- No component-library swap to shadcn/Base UI primitives (considered and deferred — see Alternatives).
- Do not touch the untracked `steward-stable/` snapshot, `.venv-dev/`, or `docker_image/dev_local/`.

## Implementation plan

Layered on `feature/steward-rebrand` (WIP checkpointed in `b7c074a`). Each task is an independently reviewable commit; per project workflow, tasks are dispatched to Codex and reviewed by Claude + `codex review`.

| # | Task | Files | Depends on |
|---|---|---|---|
| A | **Token foundation** — rewrite `styles.css` (`:root`/`.dark`/`@theme inline`), update `index.html` + `manifest.webmanifest` | `src/styles.css`, `index.html`, `public/manifest.webmanifest` | — |
| B | **Shared primitives** — retokenize inline hexes; warm `Card`, soft shadows | `src/components/ui.tsx`, `src/components/AppShell.tsx` | A |
| C | **Views group 1** — Overview, Missions, Runs | `src/views/{Overview,Missions,Runs}View.tsx` | A, B |
| D | **Views group 2** — Approvals, Team, Routing, Audit | `src/views/{Approvals,Team,Routing,Audit}View.tsx` | A, B |
| E | **Heavy components** — RunInspector, ApprovalDrawer, DecisionModals, ImpactSummaryCard, ApprovalCard, AgentQueueModal | `src/components/*` | A, B |
| F | **Semantic pass + tests** — teal-as-status + severity glyphs sweep; fix any test asserting literal hex/class; final verification | mixed + `test/`, `tests/e2e/` | C, D, E |

C/D/E are mutually independent (disjoint files) and may run in parallel after B.

## Verification

- `npm run test` (vitest) and Playwright e2e (`tests/e2e/steward.spec.ts`, `task-board.spec.ts`) stay green — this is presentation-only, so failures indicate a real regression or a test asserting an old literal.
- Type/lint: `tsc` via build stays clean.
- **Visual proof** — run the Vite dev server bound to `0.0.0.0` and hand off `http://100.72.64.97:PORT/` (Tailscale) for live review across light (and dark via `.dark` on `<html>`), desktop + mobile widths.

## Risks

- **Tests asserting literal colors/classes** — audited and updated within Task F (and per-task where a test breaks).
- **Inline-hex misses** — a stray hardcoded hex breaks the later dark flip; Task F sweeps for remaining `#[0-9a-f]{3,6}` in `src/`.
- **Contrast regressions on warm paper** — the darkened `teal-700 #1b655d` and ink foreground are the AA-verified pairings; do not reintroduce `#237a72` as text-on-light.

## Alternatives Considered

- **Token/asset swap only** — faithful but minimal; rejected as underwhelming for "redesign the entire site."
- **Rebuild on shadcn/Base UI (`base-nova`) primitives** — max long-term consistency with the estate, but high effort/risk to a working, tuned app; deferred as a possible follow-up once tokens align.
- **Add a working dark-mode toggle now** — brand philosophy is light-by-default; building the toggle UI is deferred while still structuring tokens so it's a cheap later addition.
- **Keep Instrument Serif accent** — rejected; flagged as a brand liability and out of place in a declarative operator console.
