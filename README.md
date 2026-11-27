# diff-speed-01-run-20261126

[![make.fun](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/calebakinjomo/diff-speed-01-run-20261126/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/calebakinjomo/diff-speed-01-run-20261126/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)

A faster drop-in for [makefun-diff 1.0.0](https://make.fun/bounty/diff-speed-01-run-20261126), make.fun's own line diff. `solve.js` returns exactly makefun-diff's patch for every `{ old, new }` input, and `main.ts` is the program the harness runs: it reads every case from `/input/cases.json`, answers each one alone with `run`, and writes `/output/answers.json`.

## How it works

- Every distinct line of a case is interned once to a small integer id, so the search compares integers, never strings.
- The common prefix of lines is kept, then the common suffix of what is left.
- Between them, Myers's greedy search runs over `Int32Array` furthest-reaching arrays, with make.fun's tie-break (a deletion wins when a deletion and an insertion reach the same point into the old text), the reference's boundary guards (no move past either text's end, no diagonal pruned at the edges), and one furthest-reaching snapshot per edit depth so the exact path can be recovered by backtracking.
- The patch is built exactly as makefun-diff/1 writes it: header line, hunks with 3 kept lines of context on each side (runs at most 6 kept lines apart share a hunk, deletions before insertions inside a run), and a `%` line after a line that ends its text with no newline.

Nothing is cached from one case to the next; the output is deterministic.

## Run it

```sh
node main.ts
```

Node 22, no dependencies, nothing to install.

## License

MIT — see [LICENSE](LICENSE).
