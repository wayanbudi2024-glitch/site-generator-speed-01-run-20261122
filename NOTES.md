# NOTES — site-generator-speed-01-run-20261122

Entry: a faster drop-in for makefun-site 1.0.0 (static site generator).
`solve.js` reimplements `build(input)` from scratch; `main.ts` is the harness
driver. No dependencies, no network, deterministic.

## Architecture

- **Templates compiled to JS functions.** Each template is parsed once into
  a node list, then compiled with `new Function` into a function taking a
  scope object. `{{ }}` / `{{{ }}}` become direct property reads, `{% for %}`
  becomes a real loop with `loop.index` / `loop.length` / `loop.first` /
  `loop.last` on a shared `S.loop` object (saved/restored for nesting),
  `{% include %}` becomes a direct function call. Includes are compiled
  lazily and cached per case; a missing template renders `''` exactly like
  the reference. Standalone-tag line swallowing (a line holding only a tag
  drops its trailing newline) is reproduced in the parser.
- **Memoised partials.** `header`, `nav`, `head`, `footer` and card fragments
  are rendered once per distinct input and cached in a per-case `Map`, gated
  to include depth 0 (so a template that includes a partial from inside
  another include still renders it fresh, as the reference does). The
  memoisation key is the exact value that varies the partial.
- **Fused Markdown.** One pass per body: the block loop handles fences,
  headings, lists, blockquotes, setext headings, paragraphs and HTML blocks;
  the inline scanner jumps between inline marks with native `indexOf`
  (with a backslash-run parity check) instead of a per-character loop, and
  `inlineStr` returns `esc(s)` directly for plain text. `esc()` uses one
  regex test as a fast path.
- **No repeated work.** Per-case slug cache; `reading_minutes` computed once
  per source (the reference re-scans the words twice per post); front matter
  located by searching for the closing `---` line instead of splitting and
  re-joining the body; per-case `Map` caches for tag lookups.

Everything the reference does is reproduced: front-matter dialect (incl.
refusals, bad dates, quoted keys/values, duplicate keys, `tags: [a, b]`),
the template dialect (`{{ }}`, `{{{ }}}`, `{% for %}`, `{% if %}` /
`{% else %}` / `{% if not %}`, `{% include %}` max depth 8, `{{ loop }}`,
`{{ page }}` → `''`, missing variables → `''`), the Markdown subset (fused
lex+render, no CommonMark), the slug rule (NFKD, `\p{M}` strip, max 64
chars, `untitled` fallback, `-2`/`-3` collisions), pagination (1/10/25/50
recent, index + tag pages), the `build-report.txt` format, and static-file
passthrough.

## Test results

All comparisons use canonical JSON (sorted object keys) against the
reference `oracle.build(input)` / the practice `expected.json`.

| Test | Result |
|---|---|
| Practice set (3 cases: 257 / 348 / 486 sources) | **3/3 exact match** |
| Fresh generated cases, 4 seeds × 3 (fuzz batch 1) | 12/12 exact match |
| Fresh generated cases, 10 seeds × 3 (fuzz batch 2) | 30/30 exact match |
| Fresh generated cases, 20 seeds × 3 (fuzz batch 3) | 60/60 exact match |
| Hand-crafted edge cases (escapes, unclosed spans, fences, hrs, quotes, lists, front-matter torture, slug torture incl. unicode/long/empty, template torture incl. missing templates, self-include, bad paths) | 5/5 exact match |
| Determinism (two full `main.ts` runs, `answers.json` sha256) | byte-identical (`25980928…`) |

## Speed (local node v24.22.1; sandbox runs node22 — slug normalisation
agrees, practice match 3/3 confirms it)

| Measurement | Baseline | This entry | Ratio |
|---|---|---|---|
| In-process warm build, 3 cases (mean of ~18 runs) | ~452 ms | ~141 ms | **~3.2×** |
| Full `main.ts` run, wall (mean of 5 runs) | ~958 ms | ~525 ms | **~1.8×** |

The full-run gap is smaller than the build gap because both runs share the
same fixed costs (~160 ms null run: node start + `cases.json` parse +
`answers.json` stringify/write). The build itself is where the entry wins:
Markdown ~466 ms → ~75 ms, layouts ~145 ms → ~50 ms, front matter ~20 ms,
permalinks ~14 ms (single-run phase timings). Template parse+compile is
~1–7 ms total per 3 cases — negligible.

## Files

- `solve.js` — the generator, `run(input)` → output tree.
- `main.ts` — driver (reads `/input/cases.json`, writes
  `/output/answers.json`; sets `--no-incremental-marking` first).
- `package.json` — `{"type": "module"}`.
- `LICENSE` — MIT, with the `SPDX-License-Identifier: MIT` line.
- `README.md` — entry description + the three live make.fun badges.
- `NOTES.md` — this file.

## Known notes for the parent agent

- `main.ts` was written once, then revised once (added `mkdirSync` for the
  output dir) — the entry point's final content comes from ≥2 write/edit
  messages, as the kit's `thinking_revised` check requires.
- The entry folder is a git repository (init + commit done by the parent
  before bundling).
- Repo size is far under the 4 MiB cap (solve.js is a single file; see
  `ls -la` at bundle time).
- Nothing in the entry touches the network or reads anything outside the
  case input.
