// Git smart HTTP: info/refs advertisements (v0/v2), upload-pack (v0/v2
// fetch, v2 ls-refs) and receive-pack (v0 push with report-status).
// The client in the kit (sdk/conformance/git-client.ts) is the authority for
// the wire shapes; this file answers exactly what it sends.

import {
  fetchSet,
  isAncestor,
  parseTag,
  readPack,
  writePack,
} from './gitcore.ts';
import type { Forge, RepoRecord } from './store.ts';
import {
  ZERO_OID,
  isSha,
  pktFlush,
  pktLine,
  splitNul,
} from './util.ts';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'github-core-clone/1.0.0';
const UPLOAD_V0_CAPS = `side-band-64k thin-pack ofs-delta multi_ack_detailed shallow symref=HEAD:refs/heads/main agent=${AGENT}`;
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

function ok(body: Buffer, contentType: string): GitResponse {
  return { status: 200, contentType, body };
}

function err(status: number, message: string): GitResponse {
  return { status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(message, 'utf8') };
}

/** Scan pkt-lines from the start of `buf` until the first flush; returns the
 *  data lines and the offset just past the flush (where a raw pack starts). */
function readPktLinesUntilFlush(buf: Buffer): { lines: Buffer[]; rest: number } {
  const lines: Buffer[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (head === '0000') return { lines, rest: off + 4 };
    if (head === '0001' || head === '0002') { off += 4; continue; }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > buf.length) {
      throw new Error('bad pkt-line length ' + head);
    }
    lines.push(buf.subarray(off + 4, off + len));
    off += len;
  }
  throw new Error('pkt-line stream ends without a flush');
}

// ---------------------------------------------------------------- advertisements

function v0Advertisement(repo: RepoRecord, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const serviceLine = service === 'git-upload-pack' ? '# service=git-upload-pack\n' : '# service=git-receive-pack\n';
  const parts: Buffer[] = [pktLine(serviceLine), pktFlush()];
  const refs = repoRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headOid = headTip(repo);
    parts.push(pktLine(`${headOid} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('object-format=sha1\n'),
    pktLine('ls-refs\n'),
    pktLine('fetch=shallow\n'),
    pktFlush(),
  ];
  return Buffer.concat(parts);
}

/** All refs of a repo, sorted by name, with peeled tag targets. */
function repoRefs(repo: RepoRecord): Array<{ name: string; oid: string; peeled?: string }> {
  const out: Array<{ name: string; oid: string; peeled?: string }> = [];
  for (const [ref, oid] of repo.refs) {
    const entry: { name: string; oid: string; peeled?: string } = { name: ref, oid };
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') entry.peeled = parseTag(obj.data).object;
    out.push(entry);
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return out;
}

function headTip(repo: RepoRecord): string {
  const main = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  if (main) return main;
  const first = repoRefs(repo).find((r) => r.name.startsWith('refs/heads/'));
  return first ? first.oid : ZERO_OID;
}

export function handleInfoRefs(
  _forge: Forge,
  repo: RepoRecord,
  service: 'git-upload-pack' | 'git-receive-pack',
  gitProtocolVersion: number,
): GitResponse {
  if (service === 'git-receive-pack') {
    return ok(v0Advertisement(repo, service), 'application/x-git-receive-pack-advertisement');
  }
  if (gitProtocolVersion === 2) {
    return ok(v2Advertisement(), 'application/x-git-upload-pack-advertisement');
  }
  return ok(v0Advertisement(repo, service), 'application/x-git-upload-pack-advertisement');
}

// ---------------------------------------------------------------- upload-pack

interface FetchParams {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
}

function sidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const maxData = 65515;
  for (let off = 0; off < pack.length; off += maxData) {
    const slice = pack.subarray(off, Math.min(pack.length, off + maxData));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) chunks.push(pktLine(Buffer.from([1])));
  return Buffer.concat(chunks);
}

function fetchResponse(repo: RepoRecord, params: FetchParams, v2: boolean): GitResponse {
  const wants = [...new Set(params.wants)].filter((w) => isSha(w));
  const exclude = new Set([...params.haves, ...params.shallow]);
  const result = fetchSet(repo.objects, wants, {
    depth: params.depth,
    exclude,
    oldShallow: new Set(params.shallow),
  });
  const pack = writePack(result.send);
  const parts: Buffer[] = [];
  if (v2) {
    if (result.shallow.length > 0 || result.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of result.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(pktFlush());
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
    parts.push(pktFlush());
  } else {
    // v0: plain ACK/NAK and shallow lines, then the sideband pack.
    if (params.haves.length > 0 && params.haves.every((h) => repo.objects.has(h))) {
      parts.push(pktLine(`ACK ${params.haves[params.haves.length - 1]}\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
    for (const oid of result.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of result.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(sidebandPack(pack));
  }
  return ok(Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleLsRefs(repo: RepoRecord, lines: Buffer[]): GitResponse {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const raw of lines) {
    const line = raw.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  const refs = repoRefs(repo);
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  if (prefixes.length === 0) {
    const headLine = `${headTip(repo)} HEAD${symrefs ? ` symref-target:${defaultRef}` : ''}\n`;
    parts.push(pktLine(headLine));
  }
  for (const ref of refs) {
    if (prefixes.length > 0 && !prefixes.some((p) => ref.name.startsWith(p))) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
    parts.push(pktLine(line + '\n'));
  }
  parts.push(pktFlush());
  return ok(Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

function handleFetchV2(repo: RepoRecord, lines: Buffer[]): GitResponse {
  const params: FetchParams = { wants: [], haves: [], shallow: [] };
  for (const raw of lines) {
    const line = raw.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) params.wants.push(line.slice(5).split(' ')[0]);
    else if (line.startsWith('have ')) params.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) params.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isInteger(n) && n > 0) params.depth = n;
    }
  }
  return fetchResponse(repo, params, true);
}

function handleFetchV0(repo: RepoRecord, body: Buffer): GitResponse {
  // Two sections: wants/shallow/deepen, flush, haves/done, flush.
  const params: FetchParams = { wants: [], haves: [], shallow: [] };
  let off = 0;
  let section = 0;
  while (off + 4 <= body.length && section < 2) {
    const head = body.subarray(off, off + 4).toString('ascii');
    if (head === '0000') { section += 1; off += 4; continue; }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || off + len > body.length) throw new Error('bad pkt-line in v0 fetch');
    const line = body.subarray(off + 4, off + len).toString('utf8').replace(/\n$/, '');
    if (section === 0) {
      if (line.startsWith('want ')) params.wants.push(line.slice(5).split(' ')[0]);
      else if (line.startsWith('shallow ')) params.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number(line.slice(7).trim());
        if (Number.isInteger(n) && n > 0) params.depth = n;
      }
    } else if (line.startsWith('have ')) {
      params.haves.push(line.slice(5).trim());
    }
    off += len;
  }
  return fetchResponse(repo, params, false);
}

export function handleUploadPack(
  _forge: Forge,
  repo: RepoRecord,
  body: Buffer,
  gitProtocolVersion: number,
): GitResponse {
  try {
    if (gitProtocolVersion === 2) {
      const { lines } = readPktLinesUntilFlush(body);
      // The first line is the command; a delim separates args.
      const first = lines[0]?.toString('utf8').replace(/\n$/, '') ?? '';
      const args = lines.slice(1);
      if (first === 'command=ls-refs') return handleLsRefs(repo, args);
      if (first === 'command=fetch') return handleFetchV2(repo, args);
      return err(400, 'unknown v2 command');
    }
    return handleFetchV0(repo, body);
  } catch (e) {
    return err(400, e instanceof Error ? e.message : 'malformed request');
  }
}

// ---------------------------------------------------------------- receive-pack

export function handleReceivePack(_forge: Forge, repo: RepoRecord, body: Buffer): GitResponse {
  try {
    const { lines, rest } = readPktLinesUntilFlush(body);
    if (lines.length === 0) return err(400, 'no commands');
    const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
    let sideband = false;
    for (let i = 0; i < lines.length; i += 1) {
      let text = lines[i].toString('utf8').replace(/\n$/, '');
      if (i === 0) {
        const [before, after] = splitNul(Buffer.from(text, 'utf8'));
        text = before.toString('utf8');
        if (after) {
          const caps = after.toString('utf8').split(' ');
          sideband = caps.includes('side-band-64k');
        }
      }
      const parts = text.split(' ');
      if (parts.length !== 3 || !isSha(parts[0]) || !isSha(parts[1]) || !parts[2].startsWith('refs/')) {
        return err(400, 'bad push command');
      }
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
    const packBytes = body.subarray(rest);
    const reportLines: string[] = [];
    if (packBytes.length > 0) {
      let unpacked;
      try {
        unpacked = readPack(packBytes);
      } catch (e) {
        reportLines.push(`unpack ${e instanceof Error ? e.message : 'pack parse failed'}`);
        for (const c of commands) reportLines.push(`ng ${c.ref} unpack failed`);
        return receiveReport(reportLines, sideband);
      }
      for (const [oid, obj] of unpacked) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
      }
      reportLines.push('unpack ok');
    } else {
      reportLines.push('unpack ok');
    }
    for (const c of commands) {
      const current = repo.refs.get(c.ref);
      if (c.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined || c.oldOid !== current) {
          reportLines.push(`ng ${c.ref} non-fast-forward`);
        } else {
          repo.refs.delete(c.ref);
          reportLines.push(`ok ${c.ref}`);
        }
        continue;
      }
      if (c.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          reportLines.push(`ng ${c.ref} non-fast-forward`);
        } else if (!repo.objects.has(c.newOid)) {
          reportLines.push(`ng ${c.ref} object not found`);
        } else {
          repo.refs.set(c.ref, c.newOid);
          reportLines.push(`ok ${c.ref}`);
        }
        continue;
      }
      // Update.
      if (current === undefined || c.oldOid !== current) {
        reportLines.push(`ng ${c.ref} non-fast-forward`);
      } else if (c.newOid === c.oldOid) {
        reportLines.push(`ok ${c.ref}`);
      } else if (!repo.objects.has(c.newOid) || !isAncestor(repo.objects, c.oldOid, c.newOid)) {
        reportLines.push(`ng ${c.ref} non-fast-forward`);
      } else {
        repo.refs.set(c.ref, c.newOid);
        reportLines.push(`ok ${c.ref}`);
      }
    }
    return receiveReport(reportLines, sideband);
  } catch (e) {
    return err(400, e instanceof Error ? e.message : 'malformed request');
  }
}

function receiveReport(lines: string[], sideband: boolean): GitResponse {
  const stream = Buffer.concat(lines.map((l) => pktLine(l + '\n')));
  let body: Buffer;
  if (sideband) {
    body = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), stream])), pktFlush()]);
  } else {
    body = Buffer.concat([stream, pktFlush()]);
  }
  return ok(body, 'application/x-git-receive-pack-result');
}
