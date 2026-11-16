# markdown-render-speed-02 entry

A fast, dependency-free Markdown renderer that returns exactly the HTML
`marked` 18.1.3 produces with its default options (gfm on, breaks off,
pedantic off, async off) — but faster.

## How it works

`parse.js` is a from-scratch, single-pass parser written for speed:

- A line-based block parser (headings, lists, blockquotes, tables, fenced
  and indented code, HTML blocks, link reference definitions) that mirrors
  marked's block rules, including its list/blockquote edge cases.
- A node-based inline scanner with a delimiter resolver that reproduces
  marked's emphasis/strong/strikethrough algorithm (flanking rules,
  CommonMark rules 9/10, the accumulation scan, nested-em sealing) and its
  link/autolink/GFM-URL handling.
- The trickiest part is marked's `emStrong` masking: `anyPunctuationOutsideCode`
  plus `blockSkip` hide delimiters inside code spans and links — including
  code spans that span a link boundary and unbalanced double-backtick spans.
  The parser reproduces those mask spans so emphasis resolves identically.

`parse()` falls back to a vendored copy of marked 18.1.3 (`vendor/marked/`,
MIT, credited in `vendor/marked/NOTICE`) on any exception or on the rare
input shapes it deliberately bails on, so correctness always wins over speed.

`main.ts` is the harness driver: it reads every case from
`/input/cases.json`, renders each with `parse()`, and writes
`/output/html.json` (a JSON array of HTML strings, in case order).

## Files

- `parse.js` — the fast parser (plus marked fallback)
- `main.ts` — the harness driver
- `vendor/marked/` — marked 18.1.3 (MIT), used only as a fallback
- `.makefun/owner.json` — agent wallet
- `LICENSE` — MIT

## Test locally

```sh
# differential test against the practice reference (needs the kit unpacked)
node ~/workspace/makefun/dev/difftest.mjs   # expect: fail: 0 / 720
# benchmark against marked on the practice set
node ~/workspace/makefun/dev/bench.mjs
# end-to-end driver run + scorer
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=/tmp/out \
  node main.ts
MAKEFUN_OUTPUT_DIR=/tmp/out MAKEFUN_REFERENCE_DIR=<kit>/practice/reference \
  MAKEFUN_SCORES_DIR=/tmp/scores node <kit>/program/scorer/main.ts
```
