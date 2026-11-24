// mend — one patch tool for every AI edit format (hidden-spec-cli-01-run-20261122).
//
// Implements SPEC.md in full: unified diffs, SEARCH/REPLACE blocks, V4A patches and
// JSON edits, matched at three tiers (exact, trailing-whitespace, trimmed), applied
// atomically, with the exact stdout and exit codes the spec requires. Node 22,
// standard library only; run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and this
// file hands over to runner.ts (the last lines below): keep that hand-over and
// runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines: split at `\n`, one trailing `\r` removed, no empty piece after a final `\n`. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** One file's text as lines, its line break and whether it ends with one. */
interface F {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitFile(text: string): F {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function joinFile(f: F): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.fin ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  moves: { old: string; nw: string }[] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  file(p: string): F | null {
    const t = this.get(p);
    return t === null ? null : splitFile(t);
  }
}

type Edit = (tree: Tree) => void;

/** A line normalised for a matching tier: 0 exact, 1 trailing spaces/tabs off, 2 both ends off. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** Every 0-based position where O occurs in the file's lines at a tier (occurrences may overlap). */
function occurrences(file: string[], o: string[], tier: number): number[] {
  const res: number[] = [];
  const on = o.map((l) => normLine(l, tier));
  for (let i = 0; i + o.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (normLine(file[i + j]!, tier) !== on[j]) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

/** The first tier at which O occurs at least once (only tier 0 when strict), or null. */
function findTier(file: string[], o: string[], strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(file, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first tier at which O occurs at or after `from`, or null. */
function findTierFrom(file: string[], o: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    const occ = occurrences(file, o, t).filter((q) => q >= from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/**
 * O replaced by N at position pos. A context line of N (nCtx[i] an index into O) is written
 * as the file's own matched line; at tier 2 every other line of N is re-indented from O's
 * first line's leading spaces/tabs to the file's first matched line's.
 */
function spliceLines(file: string[], o: string[], n: string[], nCtx: (number | null)[], pos: number, tier: number): string[] {
  const lead = (s: string): string => {
    const m = /^[ \t]*/.exec(s);
    return m === null ? '' : m[0];
  };
  let made = n.map((l, i) => {
    const oi = nCtx[i];
    return oi === null ? l : file[pos + oi]!;
  });
  if (tier === 2 && o.length > 0) {
    const P = lead(o[0]!);
    const F = lead(file[pos]!);
    made = made.map((l, i) => {
      if (nCtx[i] !== null) return l;
      if (l === '' || /^[ \t]+$/.test(l)) return l;
      return l.startsWith(P) ? F + l.slice(P.length) : l;
    });
  }
  return [...file.slice(0, pos), ...made, ...file.slice(pos + o.length)];
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const f = splitFile(before);
      if (line < 0 || line > f.lines.length) throw new Fail('no-match', p);
      f.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(f));
    };
  }
  return null;
}

/** A JSON patch (section 9): one array of edit objects, or JSON Lines. */
function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Format detection (section 4), or null when no format holds. */
function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------- unified diffs (section 6)

interface HunkBodyLine {
  kind: 'ctx' | 'del' | 'add' | 'bs';
  text: string;
}
interface Hunk {
  a: number;
  body: HunkBodyLine[];
}
interface Section {
  oldPath: string | null; // null: /dev/null, no file
  newPath: string | null;
  create: boolean;
  del: boolean;
  hunks: Hunk[];
}

/** O, N and the context mapping of one hunk or chunk body. */
function bodyON(body: HunkBodyLine[]): { o: string[]; n: string[]; nCtx: (number | null)[]; bsAfterLastCtxAdd: boolean; bsAfterLastAdd: boolean } {
  const o: string[] = [];
  const n: string[] = [];
  const nCtx: (number | null)[] = [];
  let lastCtxAdd = -1;
  let lastAdd = -1;
  body.forEach((b, i) => {
    if (b.kind === 'ctx') {
      o.push(b.text);
      n.push(b.text);
      nCtx.push(o.length - 1);
      lastCtxAdd = i;
    } else if (b.kind === 'del') {
      o.push(b.text);
    } else if (b.kind === 'add') {
      n.push(b.text);
      nCtx.push(null);
      lastCtxAdd = i;
      lastAdd = i;
    }
  });
  return {
    o,
    n,
    nCtx,
    bsAfterLastCtxAdd: lastCtxAdd >= 0 && body[lastCtxAdd + 1]?.kind === 'bs',
    bsAfterLastAdd: lastAdd >= 0 && body[lastAdd + 1]?.kind === 'bs',
  };
}

/** The path after `--- ` or `+++ `: text after four characters, up to the first tab, spaces trimmed, a/ or b/ stripped. */
function diffPath(line: string): string | null {
  const raw = line.slice(4).split('\t')[0]!.trim();
  if (raw === '/dev/null') return null;
  if (raw.startsWith('a/') || raw.startsWith('b/')) return raw.slice(2);
  return raw;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  const n = lines.length;
  const diffGitRe = /^diff --git a\/(.+?) b\/(.+)$/;
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  let cur: Section | null = null;
  let header = false; // the current section is still before its first hunk
  let sawPaths = false; // the current section's header already took a ---/+++ pair
  let i = 0;
  const startSection = (oldPath: string | null, newPath: string | null): void => {
    cur = { oldPath, newPath, create: false, del: false, hunks: [] };
    sections.push(cur);
    header = true;
    sawPaths = false;
  };
  while (i < n) {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) {
      const m = diffGitRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection(m[1]!, m[2]!);
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && header && !sawPaths) {
        cur.oldPath = diffPath(l);
        cur.newPath = diffPath(lines[i + 1]!);
        sawPaths = true;
        i += 2;
        continue;
      }
      startSection(diffPath(l), diffPath(lines[i + 1]!));
      sawPaths = true;
      i += 2;
      continue;
    }
    if (l.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = hunkRe.exec(l);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: Number(m[1]), body: [] };
      cur.hunks.push(hunk);
      header = false;
      i++;
      // the body: lines starting with ' ', '-', '+', '\', or empty; ends at the first other
      // line, at a `diff --git ` line, at a `--- ` line followed by a `+++ ` line, or at the end
      while (i < n) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b.startsWith(' ')) hunk.body.push({ kind: 'ctx', text: b.slice(1) });
        else if (b.startsWith('-')) hunk.body.push({ kind: 'del', text: b.slice(1) });
        else if (b.startsWith('+')) hunk.body.push({ kind: 'add', text: b.slice(1) });
        else if (b.startsWith('\\')) hunk.body.push({ kind: 'bs', text: b.slice(1) });
        else if (b === '') hunk.body.push({ kind: 'ctx', text: '' });
        else break;
        i++;
      }
      // empty lines at the end of a body are not part of it
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1]!.kind === 'ctx' && hunk.body[hunk.body.length - 1]!.text === '') hunk.body.pop();
      continue;
    }
    if (cur !== null && header) {
      if (l.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (l.startsWith('rename from ')) cur.oldPath = l.slice('rename from '.length).trim();
      else if (l.startsWith('rename to ')) cur.newPath = l.slice('rename to '.length).trim();
      else if (l.startsWith('new file mode')) cur.create = true;
      else if (l.startsWith('deleted file mode')) cur.del = true;
      // every other header line is ignored
      i++;
      continue;
    }
    // outside bodies, lines that are not part of a section header are ignored
    i++;
  }
  return sections.map((sec) => sectionEdit(sec, strict));
}

/** One unified section's hunks applied to a file's lines, in order. */
function applyHunks(f: F, hunks: Hunk[], strict: boolean, path: string): F {
  let cur = f;
  let d = 0;
  for (const h of hunks) {
    const { o, n, nCtx, bsAfterLastCtxAdd } = bodyON(h.body);
    if (o.length === 0) {
      const at = Math.min(h.a + d, cur.lines.length);
      const atEnd = at === cur.lines.length;
      cur = { lines: [...cur.lines.slice(0, at), ...n, ...cur.lines.slice(at)], br: cur.br, fin: atEnd ? !bsAfterLastCtxAdd : cur.fin };
    } else {
      const found = findTier(cur.lines, o, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let pos = found.occ[0]!;
      let best = Math.abs(pos - target);
      for (const q of found.occ) {
        const dist = Math.abs(q - target);
        if (dist < best) {
          best = dist;
          pos = q;
        }
      }
      const atEnd = pos + o.length === cur.lines.length;
      cur = { lines: spliceLines(cur.lines, o, n, nCtx, pos, found.tier), br: cur.br, fin: atEnd ? !bsAfterLastCtxAdd : cur.fin };
    }
    d += n.length - o.length;
  }
  return cur;
}

/** One unified section as one edit. */
function sectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldPath;
    const newP = sec.newPath;
    if (sec.create || oldP === null) {
      const p = newP;
      if (p === null || !safe(p)) throw new Fail('unsafe', p ?? '');
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const lines: string[] = [];
      let fin = true;
      for (const h of sec.hunks) {
        const { n, nCtx, bsAfterLastAdd } = bodyON(h.body);
        let hasAdd = false;
        n.forEach((l, idx) => {
          if (nCtx[idx] === null) {
            lines.push(l);
            hasAdd = true;
          }
        });
        if (hasAdd) fin = !bsAfterLastAdd;
      }
      tree.now.set(p, joinFile({ lines, br: '\n', fin }));
      return;
    }
    if (sec.del || newP === null) {
      const p = oldP;
      if (p === null || !safe(p)) throw new Fail('unsafe', p ?? '');
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const f = applyHunks(tree.file(oldP)!, sec.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, joinFile(f));
      tree.moves.push({ old: oldP, nw: newP });
      return;
    }
    const p = oldP;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, joinFile(applyHunks(tree.file(p)!, sec.hunks, strict, p)));
  };
}

// ---------------------------------------------------------------- SEARCH/REPLACE blocks (section 7)

function srEdit(path: string, old: string[], nw: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (old.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, joinFile({ lines: nw, br: '\n', fin: true }));
      return;
    }
    const t = tree.get(path);
    if (t === null) throw new Fail('missing', path);
    const f = splitFile(t);
    const found = findTier(f.lines, old, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    tree.now.set(path, joinFile({ ...f, lines: spliceLines(f.lines, old, nw, nw.map(() => null), found.occ[0]!, found.tier) }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let lastEnd = 0;
  let prevPath: string | null = null;
  while (i < n) {
    let j = -1;
    for (let k = i; k < n; k++) {
      if (lines[k]!.trimEnd() === '<<<<<<< SEARCH') {
        j = k;
        break;
      }
    }
    if (j < 0) break;
    let path: string | null = null;
    for (let k = j - 1; k >= lastEnd; k--) {
      const t = lines[k]!.trim();
      if (t !== '' && !t.startsWith('```')) {
        path = t;
        break;
      }
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${j + 1}`);
    let m = -1;
    for (let k = j + 1; k < n; k++) {
      if (lines[k]!.trimEnd() === '=======') {
        m = k;
        break;
      }
    }
    if (m < 0) throw new Exit2(`error: parse ${j + 1}`);
    let r = -1;
    for (let k = m + 1; k < n; k++) {
      if (lines[k]!.trimEnd() === '>>>>>>> REPLACE') {
        r = k;
        break;
      }
    }
    if (r < 0) throw new Exit2(`error: parse ${j + 1}`);
    edits.push(srEdit(path, lines.slice(j + 1, m), lines.slice(m + 1, r), strict));
    prevPath = path;
    lastEnd = r + 1;
    i = r + 1;
  }
  return edits;
}

// ---------------------------------------------------------------- V4A patches (section 8)

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: HunkBodyLine[];
}

/** The first line at or after `from` equal to the anchor at the first tier with one, or -1. */
function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    for (let i = from; i < lines.length; i++) {
      if (normLine(lines[i]!, t) === normLine(anchor, t)) return i;
    }
  }
  return -1;
}

function v4aUpdateEdit(p: string, moveTo: string | null, chunks: V4aChunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let f = splitFile(t);
    let cursor = 0;
    for (const ch of chunks) {
      const { o, n, nCtx } = bodyON(ch.body);
      if (ch.anchor !== null) {
        const idx = findAnchor(f.lines, ch.anchor, cursor, strict);
        if (idx < 0) throw new Fail('no-match', p);
        cursor = idx + 1;
      }
      if (o.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        f = { ...f, lines: [...f.lines.slice(0, at), ...n, ...f.lines.slice(at)] };
        cursor = at + n.length;
        continue;
      }
      const found = findTierFrom(f.lines, o, cursor, strict);
      if (found === null) throw new Fail('no-match', p);
      let pos = -1;
      if (ch.eof) {
        pos = found.occ.find((q) => q + o.length - 1 === f.lines.length - 1) ?? -1;
        if (pos < 0) throw new Fail('no-match', p);
      } else {
        pos = found.occ[0]!;
      }
      f = { ...f, lines: spliceLines(f.lines, o, n, nCtx, pos, found.tier) };
      cursor = pos + n.length;
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(p, null);
      tree.now.set(moveTo, out);
      tree.moves.push({ old: p, nw: moveTo });
    } else {
      tree.now.set(p, out);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const isSectionStart = (s: string): boolean => s.startsWith('*** Add File: ') || s.startsWith('*** Delete File: ') || s.startsWith('*** Update File: ');
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && blank(lines[i]!)) i++;
    if (i >= last) break;
    const l = lines[i]!;
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice('*** Add File: '.length).trim();
      i++;
      const flines: string[] = [];
      while (i < last) {
        const s = lines[i]!;
        if (isSectionStart(s)) break;
        if (s.startsWith('+')) {
          flines.push(s.slice(1));
          i++;
        } else if (s === '') {
          flines.push('');
          i++;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (flines.length > 0 && flines[flines.length - 1] === '') flines.pop();
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) !== null) throw new Fail('exists', p);
        tree.now.set(p, joinFile({ lines: flines, br: '\n', fin: true }));
      });
    } else if (l.startsWith('*** Delete File: ')) {
      const p = l.slice('*** Delete File: '.length).trim();
      i++;
      while (i < last && blank(lines[i]!)) i++;
      if (i < last && !isSectionStart(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      });
    } else if (l.startsWith('*** Update File: ')) {
      const p = l.slice('*** Update File: '.length).trim();
      const updateLine = i + 1;
      i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: V4aChunk[] = [];
      let cur: V4aChunk | null = null;
      let firstChunk = true;
      while (i < last) {
        const s = lines[i]!;
        if (isSectionStart(s)) break;
        if (s.startsWith('@@')) {
          if (cur !== null) {
            chunks.push(cur);
            cur = null;
          }
          const anchor = s.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          firstChunk = false;
          i++;
          continue;
        }
        if (s === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
          cur.eof = true;
          chunks.push(cur);
          cur = null;
          i++;
          continue;
        }
        if (s === '' && cur === null && !firstChunk) {
          // a blank line between chunks: skip it when the next non-blank line ends the
          // section or starts a chunk; otherwise it belongs to a body line that follows
          let k = i + 1;
          while (k < last && blank(lines[k]!)) k++;
          if (k >= last || isSectionStart(lines[k]!) || lines[k]!.startsWith('@@')) {
            i = k;
            continue;
          }
          // it precedes a body line: fall through and let that line raise the parse error
          throw new Exit2(`error: parse ${i + 1}`);
        }
        if (s.startsWith(' ') || s.startsWith('-') || s.startsWith('+') || s === '') {
          if (cur === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, eof: false, body: [] };
            firstChunk = false;
          }
          cur.body.push(
            s === '' ? { kind: 'ctx', text: '' }
            : s.startsWith(' ') ? { kind: 'ctx', text: s.slice(1) }
            : s.startsWith('-') ? { kind: 'del', text: s.slice(1) }
            : { kind: 'add', text: s.slice(1) },
          );
          i++;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      if (cur !== null) chunks.push(cur);
      // blank lines at the end of a section are not part of it
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1]!;
        while (lc.body.length > 0 && lc.body[lc.body.length - 1]!.kind === 'ctx' && lc.body[lc.body.length - 1]!.text === '') lc.body.pop();
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
      edits.push(v4aUpdateEdit(p, moveTo, chunks, strict));
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
  }
  return edits;
}

// ---------------------------------------------------------------- the command line (sections 1, 2, 10)

interface Row {
  key: string;
  text: string;
  act: 'A' | 'D' | 'M' | 'R';
  path: string;
  old?: string;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? parseUnified(lines, strict) : kind === 'search-replace' ? parseSearchReplace(lines, strict) : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesLen = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesLen;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Row[] = [];
  for (const p of [...tree.now.keys()]) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`, act: was === null ? 'A' : now === null ? 'D' : 'M', path: p });
  }
  // a move replaces its pair's D and A lines with one R line, sorting by the new path
  const chain = new Map<string, string>();
  for (const m of tree.moves) {
    const og = chain.get(m.old) ?? m.old;
    chain.delete(m.old);
    chain.set(m.nw, og);
  }
  for (const [nw, og] of chain) {
    if (tree.original(og) !== null && tree.get(og) === null && tree.original(nw) === null && tree.get(nw) !== null) {
      const di = rows.findIndex((r) => r.act === 'D' && r.path === og);
      const ai = rows.findIndex((r) => r.act === 'A' && r.path === nw);
      if (di >= 0 && ai >= 0) {
        rows.splice(Math.max(di, ai), 1);
        rows.splice(Math.min(di, ai), 1);
        rows.push({ key: nw, text: `R ${og} -> ${nw}`, act: 'R', path: nw, old: og });
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const r of rows) {
      if (r.act === 'D') rmSync(r.path, { force: true });
      else if (r.act === 'R') {
        const now = tree.get(r.path)!;
        mkdirSync(dirname(r.path), { recursive: true });
        writeFileSync(r.path, now);
        rmSync(r.old!, { force: true });
      } else {
        const now = tree.get(r.path)!;
        mkdirSync(dirname(r.path), { recursive: true });
        writeFileSync(r.path, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
