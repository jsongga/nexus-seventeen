# Rebrand hex → token map

Authoritative mapping for the Steward brand redesign. Every inline hex in
`src/**/*.tsx` collapses to one of these token utilities (defined in
`src/styles.css`). **Role decides the token**, so a color used as a border maps
to a `border-*` token and the same color used as a fill maps to a `bg-*` token.
When a hex isn't listed, pick the closest-role token from the same family and
note it in your report.

Rules that apply everywhere:
- Card/panel fills currently using `bg-white` → `bg-card` (warm off-white).
  Keep white only for popovers/modals/inputs (`bg-popover` / `bg-surface`).
- Never introduce white text on teal; teal fills carry ink text.
- Preserve all markup, layout, props, and logic. Colors only.

## Teal — "measured & normal" status only
| Source hexes | Token |
|---|---|
| `#41bbb0` | `teal-500` (fill/mark) — `bg-teal-500` / `text-teal-500` |
| `#36a99f` | `teal-600` (fill hover) — `hover:bg-teal-600` |
| `#237a72` `#195f59` `#365f5b` `#416b66` | `text-teal-700` (teal text on light) |
| `#7fe0d6` | `text-teal-300` (teal on dark) / accents |
| `#b9ddd9` `#94cac4` `#8fc8c2` `#8bcfc8` `#b8ded9` | `border-teal-border` |
| `#e8f5f3` `#d5eeeb` `#e7f7f5` `#edf8f7` `#d9f3f0` `#f5faf9` `#cfe2df` | `bg-teal-soft` (wash) |

## Neutral (cool grays collapse to warm tokens)
| Source hexes | Token |
|---|---|
| `#171c24` `#222a34` `#273139` `#333c46` | `text-ink` |
| `#57595f` `#59636e` `#59636d` `#4f5c64` `#4f5964` `#66707a` `#65707b` `#5f6973` `#5f6a74` `#46515b` `#47535c` `#655e5d` `#62716f` `#5d6771` `#3f4953` `#3f4852` `#404a54` `#37424a` `#3a444f` `#39434d` `#4c6472` `#9aa2ab` `#aab1b8` `#aeb6bc` | `text-muted` |
| `#eef0f2` `#e9ecef` `#e1e5e8` `#e2e3ea` `#d9dde1` `#d9dde1` | `border-line-soft` (as border) |
| `#e4e7ea` `#d7dce0` `#d7dce1` `#cdd3d8` | `border-line` |
| `#c9cfd4` `#c8ced4` `#c8cdd2` `#c7cdd2` | `border-line-strong` (hover borders) |
| `#fafafa` `#fafbfb` `#fdfdfd` `#f7f8f8` `#f5f7f9` | `bg-card` (near-white fills/hover) |
| `#f4f5f6` `#e8eaec` `#e9ecef` (as fill) | `bg-muted-surface` (sunken chips) |
| `#e6e5df` | `bg-secondary` |

## Amber / caution
| Source hexes | Token |
|---|---|
| `#8a5d0a` `#6c4908` `#684908` `#665a42` | `text-caution` |
| `#f0b429` `#e8b04b` | `bg-caution-fill` |
| `#fff6df` `#fff5dc` `#fff9ea` | `bg-caution-soft` |
| `#ead09b` `#f0d391` `#f6dfad` `#e8c675` `#eadcb9` `#f0d9a8` | `border-caution-border` |

## Red / urgent
| Source hexes | Token |
|---|---|
| `#a01c14` (light) `#ff8a7a` (dark) | `text-urgent` |
| `#7d1710` | `bg-urgent-fill` |
| `#fff0ee` `#fff1ef` `#fff9f8` `#f8d8d5` | `bg-urgent-soft` |
| `#e5b7b3` `#e8b5af` `#efb9b2` `#d5a19d` `#bd726c` | `border-urgent-border` |

## Blue → info (off-brand category chip, tokenized for dark-safety)
| Source hexes | Token |
|---|---|
| `#3f6073` `#52758b` `#4c6472` `#5f6a74` | `text-info` |
| `#eef3f6` `#dce9ef` `#d9e1e7` | `bg-info-soft` |
| `#ccd9e2` `#cbd9e1` | `border-info-border` |

## Purple → alt (off-brand category chip, tokenized for dark-safety)
| Source hexes | Token |
|---|---|
| `#55547a` `#6a688f` `#776486` `#6b5082` | `text-alt` |
| `#f2f1f7` `#e5d9f1` | `bg-alt-soft` |
| `#d5d3e3` | `border-alt-border` |

## Leave as-is (NOT brand chrome)
- Avatar / agent identity colors passed as props or `style={{ backgroundColor }}`
  (e.g. `#f0d9a8`, `#d9efec`, `#d9f3f0`) — these encode per-agent identity, not
  brand surface. Do not tokenize.
- Pure black/white in `rgba(...)` shadow/overlay expressions (e.g.
  `rgba(23,28,36,.06)`, `rgba(255,255,255,.3)`) — keep; they read on any surface.
