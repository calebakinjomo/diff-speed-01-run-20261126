// A faster drop-in for makefun-diff 1.0.0.
//
// The rule, in brief: a text is cut into lines after every "\n" (a last line
// with no "\n" is a line too; the empty text has none), the longest common
// prefix of lines is kept, then the longest common suffix of what is left,
// and between them Myers's greedy search runs with make.fun's tie-break (a
// deletion wins when a deletion and an insertion reach the same point into
// the old text; no move past either text's end; no diagonal pruned at the
// edges), following every run of lines equal in both texts as far as it goes.
// The patch is makefun-diff/1's: a header line, hunks with 3 kept lines of
// context on each side (runs at most 6 kept lines apart share a hunk,
// deletions before insertions inside a run) and a "%" line after a line that
// ends its text with no newline.
//
// Speed comes from interning every distinct line to a small integer id once
// per case (so the search compares integers, never strings), running the
// search over Int32Array furthest-reaching arrays with one snapshot per edit
// depth for backtracking, and building the patch with plain string pushes.
// Each case is answered alone; nothing is carried from one case to the next.

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/** Kept lines a hunk shows before and after each change run. */
const CONTEXT = 3;

/** The patch's first word. */
const FORMAT = 'makefun-diff/1';

/** A diagonal with no path: no furthest point. */
const DEAD = -1;

/**
 * A text's lines, each with its "\n" (the last one without, when the text
 * does not end in one), and each line's interned id. Lines equal as strings
 * share an id; a line with a "\n" never shares one with the same words
 * without it.
 */
function tokenize(text, ids) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const count = last + (parts[last] !== '' ? 1 : 0);
  const lines = new Array(count);
  const lineIds = new Int32Array(count);
  for (let i = 0; i < last; i++) {
    const line = parts[i] + '\n';
    lines[i] = line;
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    lineIds[i] = id;
  }
  if (parts[last] !== '') {
    const line = parts[last];
    lines[last] = line;
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      ids.set(line, id);
    }
    lineIds[last] = id;
  }
  return { lines, ids: lineIds };
}

/**
 * Myers's greedy search over the middle region (n old lines, m new lines,
 * both starting at `base` in the interned arrays). Returns the first edit
 * depth that reaches both ends, the diagonal it reaches them on, and one
 * furthest-reaching snapshot per depth: snaps[d] is an Int32Array of length
 * 2d + 1 holding, at index k + d, the old lines consumed on diagonal k after
 * d edits and its run of equal lines (DEAD where the diagonal has no path).
 *
 * Positions are counts of lines consumed, so a point is (x, y) with y = x - k.
 * From depth d - 1 a deletion moves one old line past the furthest point on
 * diagonal k - 1 (only while that stays inside the old text) and an
 * insertion moves one new line past the furthest point on diagonal k + 1
 * (only while that stays inside the new text); the deletion wins when both
 * reach the same point into the old text. From there the path follows every
 * run of equal lines as far as it goes.
 */
function myersSearch(a, b, base, n, m) {
  const width = 2 * (n + m) + 3;
  const off = n + m + 1;
  let vPrev = new Int32Array(width);
  let vCur = new Int32Array(width);
  vPrev.fill(DEAD);
  vCur.fill(DEAD);
  const snaps = [];

  // Depth 0: no edit yet, only the run of equal lines from the start.
  let x = 0;
  let y = 0;
  while (x < n && y < m && a[base + x] === b[base + y]) {
    x++;
    y++;
  }
  vCur[off] = x;
  snaps.push(vCur.slice(off, off + 1));
  if (x === n && y === m) return { d: 0, k: 0, snaps };

  // The snake's ends, hoisted out of the depth loop: the inner snake below
  // walks absolute indices against these instead of adding `base` per step.
  const aEnd = base + n;
  const bEnd = base + m;
  for (let d = 1; d <= n + m; d++) {
    const tmp = vPrev;
    vPrev = vCur;
    vCur = tmp;
    // One load per diagonal: the insertion source of this diagonal is the
    // deletion source of the next, so it carries over in `left`.
    let idx = off - d;
    let left = vPrev[idx - 1];
    for (let k = -d; k <= d; k += 2, idx += 2) {
      const right = vPrev[idx + 1];
      let xDel = DEAD;
      let xIns = DEAD;
      if (left !== DEAD && left < n) xDel = left + 1;
      if (right !== DEAD && right - k - 1 < m) xIns = right;
      if (xDel === DEAD && xIns === DEAD) {
        vCur[idx] = DEAD;
        left = right;
        continue;
      }
      let xx = xDel !== DEAD && (xIns === DEAD || xDel >= xIns) ? xDel : xIns;
      // The snake walks absolute indices ax/ay (ay is always ax - k), so the
      // loop adds nothing per step instead of recomputing base + xx / base + yy.
      let ax = base + xx;
      let ay = ax - k;
      while (ax < aEnd && ay < bEnd && a[ax] === b[ay]) {
        ax++;
        ay++;
      }
      xx = ax - base;
      const yy = xx - k;
      vCur[idx] = xx;
      if (xx === n && yy === m) {
        snaps.push(vCur.slice(off - d, off + d + 1));
        return { d, k, snaps };
      }
      left = right;
    }
    snaps.push(vCur.slice(off - d, off + d + 1));
  }
  throw new Error('makefun-diff: the search ended without reaching both ends');
}

/**
 * The middle region's runs, in order, by walking the snapshots back from the
 * first depth that reached both ends. At each depth the move taken is the
 * same one the forward search took (recomputed from the same snapshot values
 * with the same tie-break), the run of equal lines back to the move's point
 * is kept, and the move itself is one deleted or inserted line. Consecutive
 * runs of one kind merge, as the reference's path does.
 */
function backtrack(a, b, base, n, m, found, runs) {
  const { d: D, k: K, snaps } = found;
  const rev = [];
  const push = (kind, count) => {
    if (count <= 0) return;
    const last = rev[rev.length - 1];
    if (last !== undefined && last.kind === kind) last.count += count;
    else rev.push({ kind, count });
  };

  let d = D;
  let k = K;
  let x = snaps[D][K + D];
  let y = x - k;
  while (d > 0) {
    const prev = snaps[d - 1];
    const pd = d - 1;
    const iDel = k - 1 + pd;
    const iIns = k + 1 + pd;
    const fromDel = iDel >= 0 && iDel < prev.length ? prev[iDel] : DEAD;
    const fromIns = iIns >= 0 && iIns < prev.length ? prev[iIns] : DEAD;
    let xDel = DEAD;
    let xIns = DEAD;
    if (fromDel !== DEAD && fromDel < n) xDel = fromDel + 1;
    if (fromIns !== DEAD && fromIns - k - 1 < m) xIns = fromIns;
    const isDel = xDel !== DEAD && (xIns === DEAD || xDel >= xIns);
    const xPre = isDel ? xDel : xIns;
    const yPre = xPre - k;
    if (x > xPre) push(KEEP, x - xPre);
    if (isDel) {
      push(DELETE, 1);
      x = xPre - 1;
      y = yPre;
      k = k - 1;
    } else {
      push(INSERT, 1);
      x = xPre;
      y = yPre - 1;
      k = k + 1;
    }
    d--;
  }
  if (x > 0) push(KEEP, x);
  for (let i = rev.length - 1; i >= 0; i--) runs.push(rev[i]);
}

/** A line as the patch writes it: its op, the line, a newline, and "%" on a line of its own when it had none. */
function written(op, line) {
  return line.endsWith('\n') ? op + line : op + line + '\n%\n';
}

/** make.fun's own patch of the two texts, built from the edit script's runs. */
function buildPatch(a, b, n, m, runs) {
  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', a[at]));
      for (let i = 0; i < c.dels; i++) out.push(written('-', a[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written('+', b[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', a[at]));
  }
  return out.join('');
}

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const ids = new Map();
  const oldT = tokenize(input.old, ids);
  const newT = tokenize(input.new, ids);
  const a = oldT.lines;
  const b = newT.lines;
  const ai = oldT.ids;
  const bi = newT.ids;
  const n = a.length;
  const m = b.length;

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && ai[prefix] === bi[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && ai[n - 1 - suffix] === bi[m - 1 - suffix]) suffix++;

  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  const midN = n - prefix - suffix;
  const midM = m - prefix - suffix;
  if (midN > 0 || midM > 0) {
    const found = myersSearch(ai, bi, prefix, midN, midM);
    backtrack(ai, bi, prefix, midN, midM, found, runs);
  }
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });

  return buildPatch(a, b, n, m, runs);
}
