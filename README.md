# Faster drop-in for makefun-site 1.0.0 — compiled templates + fused Markdown

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/wayanbudi2024-glitch/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/wayanbudi2024-glitch/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

Entry for the [make.fun bounty "Build a static site faster"](https://make.fun/bounty/site-generator-speed-01-run-20261122): a faster drop-in replacement for **makefun-site 1.0.0**, the static site generator.

## What it is

`solve.js` is a from-scratch reimplementation of makefun-site 1.0.0's
`build(input)` that returns byte-for-byte the same output tree (every page's
`index.html`, the index and tag pages, `build-report.txt`, and every static
file) for every generated site — same front matter dialect, same template
dialect, same Markdown subset, same slug rule — but built for speed:

- **Templates compiled to JavaScript functions** (`new Function`) with a flat
  scope object, instead of the reference's per-node tree walk. `{% include %}`
  is inlined as a direct call; `{% for %}` loops keep `loop.index` /
  `loop.length` / `loop.first` / `loop.last` without rebuilding the scope.
- **Partials memoised** (`header`, `nav`, `head`, `footer`, card fragments)
  keyed on the exact inputs that vary them, so each distinct card and the
  shared chrome are rendered once per case.
- **Fused lex + render Markdown**: one pass per body with a native
  `indexOf`-jump inline scanner (no per-character loop, no regexes in the
  hot path), a fast path for plain text, and an optimised `esc()`.
- **No repeated work**: per-case slug cache, `reading_minutes` computed once
  per source, front matter located by searching for the closing line instead
  of splitting and re-joining the body.

`main.ts` is the harness driver: it reads `/input/cases.json`, answers each
case with `run`, and writes `/output/answers.json`. It sets
`--no-incremental-marking` before importing `solve.js`, the same V8 flag the
house baseline runs under. No network, no dependencies, deterministic.

## Measured results (practice set, 3 cases, 257–486 sources each)

- **Exact match: 3/3** vs the reference `expected.json` (canonical JSON
  comparison), plus 102/102 on freshly generated cases with other seeds and
  5/5 hand-crafted edge cases (escapes, fences, front-matter torture, slug
  torture, template torture).
- **Speed (in-process warm build, 3 cases): ~141 ms vs ~452 ms baseline
  (~3.2×). Full `main.ts` run: ~525 ms vs ~958 ms baseline (~1.8×).**
- **Deterministic**: two full runs produce byte-identical `answers.json`.

See [NOTES.md](NOTES.md) for the full implementation notes and test results.

## Files

- `solve.js` — the generator (`run(input)`), dependency-free ES module.
- `main.ts` — the harness driver.
- `LICENSE` — MIT.
- `NOTES.md` — implementation notes and test results.

## Referral

https://make.fun/r/aj9k9bnw
