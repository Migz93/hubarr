# Colour Scheme

Hubarr uses a fixed dark-mode palette of 14 colours defined as CSS custom properties in `src/client/index.css` under the Tailwind v4 `@theme` block. All colour usage in components should reference these variables via Tailwind utility classes (`bg-*`, `text-*`, `border-*`) — no raw hex values in component code.

## The Palette

### Background scale

Six steps from darkest (page base) to lightest (hover states). Use in order of elevation — deeper backgrounds sit behind shallower ones.

| Variable | Hex | Role |
|---|---|---|
| `background` | `#0d0e12` | Page-level backgrounds, full-screen views, modal overlays |
| `background-container-low` | `#121318` | Sidebar, nav rail |
| `background-container` | `#18191e` | Default cards and panels |
| `background-container-high` | `#1e1f25` | Elevated cards, button resting state |
| `background-container-highest` | `#24252b` | Tooltips, popovers, highest elevation surfaces |
| `background-bright` | `#2a2c32` | Button hover state, interactive element hover |

### Brand / interactive

Two steps of the brand red. Use `primary-dim` for resting interactive states and `primary` only for hover — this gives a consistent brighten-on-hover feel and keeps resting contrast above WCAG AAA (7:1 against `on-surface`).

| Variable | Hex | Role |
|---|---|---|
| `primary` | `#e50914` | Hover state for buttons, active indicators, and brand accent (logo, large icons) |
| `primary-dim` | `#ae0610` | Resting state for all interactive elements: buttons, active nav item, selected filters, toggles, badges |

### Text

| Variable | Hex | Role |
|---|---|---|
| `on-surface` | `#faf8fe` | Primary text; also used as text colour on coloured backgrounds (buttons, badges, active states) |
| `on-surface-variant` | `#abaab0` | Secondary / muted text: subtitles, hints, inactive nav items, placeholder-like labels |

### Border

| Variable | Hex | Role |
|---|---|---|
| `outline-variant` | `#47484c` | Borders and dividers; typically used at reduced opacity (`/20`, `/30`) |

### Status

| Variable | Hex | Role |
|---|---|---|
| `success` | `#22c55e` | Success states, completed actions, positive indicators |
| `warning` | `#f59e0b` | Warnings, non-critical notices, restart-required badges |
| `error` | `#f07070` | Errors, validation failures, destructive action indicators |

## Contrast

All text/background pairings in active use pass WCAG AA (4.5:1 for normal text). Key ratios:

| Text | Background | Ratio |
|---|---|---|
| `on-surface` on any background step | worst case `background-bright` | 13.2:1 |
| `on-surface-variant` on any background step | worst case `background-bright` | 6.1:1 |
| `on-surface` on `primary-dim` (buttons, badges) | — | 7.0:1 (AAA) |
| `on-surface` on `primary` (hover state) | — | 4.8:1 (AA) |

## Rules

- Never use `primary` or `primary-dim` as a text colour on dark backgrounds — neither passes AA at small text sizes.
- Use `on-surface` (not raw `white`) for text on coloured backgrounds to keep the off-white tone consistent.
- Status colours (`success`, `warning`, `error`) are for text and subtle tinted backgrounds (`/10` opacity) only — do not use them as solid button backgrounds.
- `outline-variant` is a border colour only, not used for text.
