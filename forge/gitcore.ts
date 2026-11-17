// Git objects, packs, reachability, diffs and merges.
// Pure functions over a per-repo object Map; no I/O, no clocks.

import { deflateSync, inflateSync } from 'node:zlib';
import { sha1Hex, ZERO_OID, isSha } from './util.ts';

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export type ObjectStore = Map<string, GitObject>;

export function hashObject(type: GitObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

export function storeObject(store: ObjectStore, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!store.has(oid)) store.set(oid, { type, data });
  return oid;
}

export interface TreeEntry {
  mode: string; // '100644' | '100755' | '120000' | '40000'
  name: string;
  oid: string;
}

/** Parse a tree object into entries (in stored order). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const space = data.indexOf(0x20, off);
    if (space < 0) throw new Error('malformed tree: no space');
    const mode = data.subarray(off, space).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0) throw new Error('malformed tree: no NUL');
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('malformed tree: short oid');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    off = nul + 21;
  }
  return entries;
}

function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? e.name + '/' : e.name;
}

/** Build a tree object from entries (sorted git order, dirs as name + '/'). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  const parents: string[] = [];
  let tree = '';
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(c: CommitInfo): Buffer {
  const lines: string[] = [`tree ${c.tree}`];
  for (const p of c.parents) lines.push(`parent ${p}`);
  lines.push(`author ${c.author}`);
  lines.push(`committer ${c.committer}`);
  return Buffer.from(lines.join('\n') + '\n\n' + c.message, 'utf8');
}

export interface TagInfo {
  object: string;
  type: GitObjectType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let object = '';
  let type: GitObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as GitObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Resolve a directory path inside a tree; returns the tree oid or null. */
export function getTreeOid(store: ObjectStore, treeOid: string | null, path: string): string | null {
  if (!treeOid) return null;
  const parts = path.split('/').filter((p) => p.length > 0);
  let cur = treeOid;
  for (const part of parts) {
    const obj = store.get(cur);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === part);
    if (!entry || entry.mode !== '40000') return null;
    cur = entry.oid;
  }
  return cur;
}

/** Flatten a tree into path -> {oid, mode}, recursing into subtrees. */
export function flattenTree(store: ObjectStore, treeOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const walk = (oid: string, prefix: string): void => {
    const obj = store.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const e of parseTree(obj.data)) {
      const path = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.mode === '40000') walk(e.oid, path);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
  };
  walk(treeOid, '');
  return out;
}

/** Resolve a path inside a tree; returns the blob oid or null. */
export function getPathOid(store: ObjectStore, treeOid: string | null, path: string): string | null {
  if (!treeOid) return null;
  const parts = path.split('/').filter((p) => p.length > 0);
  let cur = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const obj = store.get(cur);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) {
      return entry.mode === '40000' ? null : entry.oid;
    }
    if (entry.mode !== '40000') return null;
    cur = entry.oid;
  }
  return null;
}

/** Set (or delete with blobOid null) a path in a tree; returns the new tree oid,
 *  storing any new tree objects in the store. Creates intermediate trees. */
export function setPath(store: ObjectStore, treeOid: string | null, path: string, blobOid: string | null): string {
  const parts = path.split('/').filter((p) => p.length > 0);
  const rec = (oid: string | null, depth: number): string | null => {
    const entries: TreeEntry[] = oid ? parseTree(store.get(oid)!.data) : [];
    const name = parts[depth];
    const last = depth === parts.length - 1;
    const idx = entries.findIndex((e) => e.name === name);
    if (last) {
      if (blobOid === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode: '100644', name, oid: blobOid };
      } else {
        entries.push({ mode: '100644', name, oid: blobOid });
      }
    } else {
      const childOid = idx >= 0 && entries[idx].mode === '40000' ? entries[idx].oid : null;
      const next = rec(childOid, depth + 1);
      if (next === null) {
        if (idx >= 0) entries.splice(idx, 1);
      } else if (idx >= 0) {
        entries[idx] = { mode: '40000', name, oid: next };
      } else {
        entries.push({ mode: '40000', name, oid: next });
      }
    }
    if (entries.length === 0) return null;
    const data = buildTree(entries);
    return storeObject(store, 'tree', data);
  };
  const result = rec(treeOid, 0);
  // A tree that becomes empty still needs an object: the empty tree.
  return result ?? storeObject(store, 'tree', Buffer.alloc(0));
}

/** Walk the commit graph from `start` following parents. */
export function walkAncestors(store: ObjectStore, start: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const queue = [start];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    out.push(oid);
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return out;
}

export function isAncestor(store: ObjectStore, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const queue = [desc];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (oid === anc) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return false;
}

/** The nearest common ancestor of two commits (first common found from b's side). */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancA = new Set(walkAncestors(store, a));
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (ancA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return null;
}

export interface DiffEntry {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
}

/** Diff two trees by path. */
export function diffTrees(store: ObjectStore, baseTree: string | null, headTree: string | null): DiffEntry[] {
  const base = baseTree ? flattenTree(store, baseTree) : new Map();
  const head = headTree ? flattenTree(store, headTree) : new Map();
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: DiffEntry[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b && !h) out.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
    else if (!b && h) out.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b && h && b.oid !== h.oid) out.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
  }
  return out;
}

/** Line counts for a diff entry (additions/deletions by simple LCS on lines). */
export function lineCounts(store: ObjectStore, d: DiffEntry): { additions: number; deletions: number } {
  const linesOf = (oid: string | null): string[] => {
    if (!oid) return [];
    const obj = store.get(oid);
    if (!obj) return [];
    const text = obj.data.toString('utf8');
    if (text.length === 0) return [];
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  };
  if (d.status === 'added') return { additions: linesOf(d.newOid).length, deletions: 0 };
  if (d.status === 'removed') return { additions: 0, deletions: linesOf(d.oldOid).length };
  const a = linesOf(d.oldOid);
  const b = linesOf(d.newOid);
  // LCS on lines (files here are small).
  const m = a.length;
  const n = b.length;
  const dp: number[] = new Array((m + 1) * (n + 1)).fill(0);
  const at = (i: number, j: number): number => dp[i * (n + 1) + j];
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const common = at(0, 0);
  return { additions: n - common, deletions: m - common };
}

// ---------------------------------------------------------------- packs

const TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Write a pack (version 2) of full objects only, no deltas. Entries sorted by oid. */
export function writePack(objects: Map<string, GitObject>): Buffer {
  const oids = [...objects.keys()].sort();
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  parts.push(header);
  for (const oid of oids) {
    const obj = objects.get(oid)!;
    const typeCode = TYPE_CODES[obj.type];
    const size = obj.data.length;
    // varint header: low 4 bits of size in first byte, then 7 bits per byte.
    const bytes: number[] = [];
    let remaining = size;
    let first = (typeCode << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    bytes.push(first);
    while (remaining > 0) {
      let b = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) b |= 0x80;
      bytes.push(b);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

/** Find the deflated length of the object at `pos` by binary search: the
 *  smallest L such that inflating buf[pos..pos+L] yields exactly `size` bytes.
 *  (zlib.inflateSync ignores trailing bytes, so this is exact.) */
function deflateLength(buf: Buffer, pos: number, size: number): number {
  let lo = 0;
  let hi = buf.length - pos;
  // First find any length that inflates to the expected size.
  const tryLen = (len: number): Buffer | null => {
    try {
      const out = inflateSync(buf.subarray(pos, pos + len));
      return out.length === size ? out : null;
    } catch {
      return null;
    }
  };
  if (tryLen(hi) === null) throw new Error('pack object does not inflate to expected size');
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tryLen(mid) !== null) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Read a pack of full objects (types 1-4). Delta objects are rejected:
 *  the suite's client never sends them. Returns oid -> object. */
export function readPack(buf: Buffer): Map<string, GitObject> {
  if (buf.length < 32) throw new Error('pack too short');
  if (buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack signature');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error('unsupported pack version ' + version);
  const count = buf.readUInt32BE(8);
  const out = new Map<string, GitObject>();
  let pos = 12;
  const typeByCode: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  for (let i = 0; i < count; i += 1) {
    const first = buf[pos++];
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let b = first;
    while ((b & 0x80) !== 0) {
      b = buf[pos++];
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    const type = typeByCode[typeCode];
    if (!type) throw new Error('unsupported pack object type ' + typeCode);
    const len = deflateLength(buf, pos, size);
    const data = inflateSync(buf.subarray(pos, pos + len));
    pos += len;
    const oid = hashObject(type, data);
    out.set(oid, { type, data });
  }
  return out;
}

/** All objects reachable from `wants`, depth-limited, minus what the client
 *  already holds. `exclude` is the haves plus the client's shallow boundaries;
 *  a shallow boundary contributes itself and its tree closure, but the walk
 *  stops there: its parents are exactly what a deepen is asking for.
 *  Depth N includes commits at depth 0..N-1 (N=1 is just the wants).
 *  Returns the objects to send, the new shallow boundary commits, and the old
 *  boundaries that are now unshallowed. */
export function fetchSet(
  store: ObjectStore,
  wants: string[],
  opts: { depth?: number; exclude?: Set<string>; oldShallow?: Set<string> },
): { send: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const shallowSet = opts.oldShallow ?? new Set<string>();
  const excludeClosure = new Set<string>();
  const excludeRoots = new Set<string>([...(opts.exclude ?? []), ...shallowSet]);
  if (excludeRoots.size > 0) {
    const queue = [...excludeRoots];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (excludeClosure.has(oid)) continue;
      excludeClosure.add(oid);
      const obj = store.get(oid);
      if (!obj) continue;
      if (obj.type === 'commit') {
        const c = parseCommit(obj.data);
        queue.push(c.tree);
        // A shallow boundary is held only in part: its parents are not held.
        if (!shallowSet.has(oid)) {
          for (const p of c.parents) queue.push(p);
        }
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) queue.push(e.oid);
      } else if (obj.type === 'tag') {
        queue.push(parseTag(obj.data).object);
      }
    }
  }
  const depth = opts.depth;
  const included = new Set<string>();
  const shallow: string[] = [];
  const queue: Array<{ oid: string; d: number }> = wants.map((oid) => ({ oid, d: 0 }));
  const seenCommit = new Set<string>();
  while (queue.length > 0) {
    const { oid, d } = queue.shift()!;
    if (seenCommit.has(oid)) continue;
    seenCommit.add(oid);
    const obj = store.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const target = parseTag(obj.data).object;
      included.add(oid);
      queue.push({ oid: target, d });
      continue;
    }
    if (obj.type !== 'commit') continue;
    if (depth !== undefined && d >= depth) continue;
    included.add(oid);
    const c = parseCommit(obj.data);
    // The tree closure of an included commit.
    const treeQueue = [c.tree];
    while (treeQueue.length > 0) {
      const t = treeQueue.shift()!;
      if (included.has(t)) continue;
      included.add(t);
      const tobj = store.get(t);
      if (!tobj || tobj.type !== 'tree') continue;
      for (const e of parseTree(tobj.data)) {
        if (e.mode === '40000') treeQueue.push(e.oid);
        else included.add(e.oid);
      }
    }
    if (depth !== undefined && d === depth - 1) {
      shallow.push(oid);
    } else {
      for (const p of c.parents) queue.push({ oid: p, d: d + 1 });
    }
  }
  const send = new Map<string, GitObject>();
  for (const oid of included) {
    if (excludeClosure.has(oid)) continue;
    const obj = store.get(oid);
    if (obj) send.set(oid, obj);
  }
  const unshallow: string[] = [];
  if (opts.oldShallow) {
    for (const old of opts.oldShallow) {
      if (!shallow.includes(old) && send.has(old)) {
        // Included and every parent is now available to the client.
        const obj = store.get(old);
        if (obj && obj.type === 'commit') {
          const parents = parseCommit(obj.data).parents;
          if (parents.every((p) => send.has(p) || excludeClosure.has(p))) unshallow.push(old);
        }
      }
    }
  }
  return { send, shallow, unshallow };
}

export { isSha };
