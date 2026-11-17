// Small shared helpers: SHA-1, pkt-line framing, base64, JSON replies.
// No dependencies beyond node:crypto.

import { createHash } from 'node:crypto';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function isSha(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);
}

export function isZeroOid(s: unknown): boolean {
  return s === ZERO_OID;
}

/** pkt-line for a string payload (payload is the raw bytes after the 4-hex length). */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');
export const pktResponseEnd = (): Buffer => Buffer.from('0002', 'ascii');

/** Decode a whole pkt-line stream. Returns lines in order; each line is
 *  { kind: 'data' | 'flush' | 'delim' | 'end', payload?: Buffer }.
 *  Throws on a malformed length prefix. */
export function decodePktLines(buf: Buffer): Array<{ kind: string; payload: Buffer }> {
  const out: Array<{ kind: string; payload: Buffer }> = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (head === '0000') { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (head === '0001') { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); off += 4; continue; }
    if (head === '0002') { out.push({ kind: 'end', payload: Buffer.alloc(0) }); off += 4; continue; }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) {
      throw new Error('bad pkt-line length ' + head);
    }
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

/** Split a pkt-line payload on the first NUL byte into [before, after]. */
export function splitNul(payload: Buffer): [Buffer, Buffer | null] {
  const idx = payload.indexOf(0);
  if (idx < 0) return [payload, null];
  return [payload.subarray(0, idx), payload.subarray(idx + 1)];
}

export function b64encode(data: Buffer | string): string {
  return (typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64');
}

export function b64decode(s: string): Buffer {
  return Buffer.from(s.replace(/\s+/g, ''), 'base64');
}

/** base64url without padding, for opaque GraphQL ids and cursors. */
export function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64url');
}

export function b64urlDecode(s: string): string {
  return Buffer.from(s, 'base64url').toString('utf8');
}

/** Escape a string for safe inclusion in a JSON string literal. */
export function jsonEscape(s: string): string {
  return JSON.stringify(s);
}

/** Parse a JSON body; returns null on failure. */
export function parseJson(buf: Buffer): unknown {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deterministic timestamp used for every server-created commit. */
export const FORGE_EPOCH = 1735689600; // 2025-01-01T00:00:00Z
export const FORGE_AUTHOR = 'Forge <forge@localhost>';
export const FORGE_MERGED_AT = '2025-01-01T00:00:00Z';
