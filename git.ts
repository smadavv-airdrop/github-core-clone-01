// Git smart-HTTP plumbing with no git binary: pkt-line framing, upload-pack protocol v2 (capability
// advertisement, ls-refs, fetch) and receive-pack v0 (advertisement, packfile unpack, report-status),
// plus packfile encode/decode including ref-delta and ofs-delta resolution. Built on node:zlib and
// node:crypto only.

import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { type GitObject, type Repo, Store } from './store.ts';

// ---- pkt-line ----

export function pkt(line: string | Buffer): Buffer {
  const body = typeof line === 'string' ? Buffer.from(line) : line;
  const len = body.length + 4;
  return Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0')), body]);
}
export const FLUSH = Buffer.from('0000');
export const DELIM = Buffer.from('0001');

export function readPktLines(buf: Buffer): { lines: (Buffer | null)[]; rest: Buffer } {
  const lines: (Buffer | null)[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.toString('utf8', i, i + 4), 16);
    if (Number.isNaN(len)) break;
    if (len === 0) { lines.push(null); i += 4; continue; } // flush
    if (len === 1) { lines.push(Buffer.alloc(0)); i += 4; continue; } // delim
    if (i + len > buf.length) break;
    lines.push(buf.subarray(i + 4, i + len));
    i += len;
  }
  return { lines, rest: buf.subarray(i) };
}

// ---- upload-pack v2 ----

export function uploadPackV2Advertise(): Buffer {
  const caps = [
    'version 2',
    'agent=forge/0.1',
    'ls-refs',
    'fetch=shallow',
    'server-option',
    'object-format=sha1',
  ];
  const parts = caps.map((c) => pkt(c + '\n'));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

export function uploadPackV0Advertise(repo: Repo): Buffer {
  const parts: Buffer[] = [];
  parts.push(pkt('# service=git-upload-pack\n'), FLUSH);
  const refs = sortedRefs(repo);
  const caps = 'multi_ack thin-pack side-band-64k ofs-delta agent=forge/0.1';
  if (refs.length === 0) {
    parts.push(pkt(`${'0'.repeat(40)} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach(([name, sha], idx) => {
      parts.push(pkt(idx === 0 ? `${sha} ${name}\0${caps}\n` : `${sha} ${name}\n`));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function sortedRefs(repo: Repo): [string, string][] {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

// Handle a v2 command body (ls-refs or fetch).
export function uploadPackV2(repo: Repo, body: Buffer): Buffer {
  const { lines } = readPktLines(body);
  let command = '';
  const args: string[] = [];
  for (const l of lines) {
    if (l === null || l.length === 0) continue;
    const s = l.toString('utf8').replace(/\n$/, '');
    if (s.startsWith('command=')) command = s.slice('command='.length);
    else args.push(s);
  }
  if (command === 'ls-refs') return lsRefsResponse(repo, args);
  if (command === 'fetch') return fetchResponse(repo, args);
  return Buffer.concat([FLUSH]);
}

function lsRefsResponse(repo: Repo, args: string[]): Buffer {
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const parts: Buffer[] = [];
  const head = repo.refs.get('HEAD') ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const emit = (name: string, sha: string): void => {
    if (prefixes.length && !prefixes.some((p) => name.startsWith(p))) return;
    let line = `${sha} ${name}`;
    if (symrefs && name === 'HEAD') line += ` symref-target:refs/heads/${repo.defaultBranch}`;
    if (peel) {} // only annotated tags peel; none here
    parts.push(pkt(line + '\n'));
  };
  if (head) emit('HEAD', head);
  for (const [name, sha] of sortedRefs(repo)) emit(name, sha);
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function fetchResponse(repo: Repo, args: string[]): Buffer {
  const wants = args.filter((a) => a.startsWith('want ')).map((a) => a.slice(5, 45));
  const haves = new Set(args.filter((a) => a.startsWith('have ')).map((a) => a.slice(5, 45)));
  const done = args.includes('done');
  const parts: Buffer[] = [];
  // acknowledgments section
  parts.push(pkt('acknowledgments\n'));
  let common = false;
  for (const h of haves) if (repo.objects.has(h)) { parts.push(pkt(`ACK ${h}\n`)); common = true; }
  if (!common) parts.push(pkt('NAK\n'));
  if (!done && haves.size > 0) { parts.push(FLUSH); return Buffer.concat(parts); }
  parts.push(DELIM);
  // packfile section
  parts.push(pkt('packfile\n'));
  const need = collectObjects(repo, wants, haves);
  const pack = buildPack(repo, need);
  // side-band-64k: band 1 = pack data
  for (let i = 0; i < pack.length; i += 65515) {
    const chunk = pack.subarray(i, i + 65515);
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function collectObjects(repo: Repo, wants: string[], haves: Set<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (sha: string): void => {
    if (seen.has(sha) || haves.has(sha)) return;
    const o = repo.objects.get(sha);
    if (!o) return;
    seen.add(sha);
    out.push(sha);
    if (o.type === 'commit') {
      const tree = o.data.toString('utf8').match(/^tree ([0-9a-f]{40})/m);
      if (tree) walk(tree[1]);
      for (const p of o.data.toString('utf8').matchAll(/^parent ([0-9a-f]{40})/gm)) walk(p[1]);
    } else if (o.type === 'tree') {
      for (const e of parseTreeRaw(o.data)) walk(e.sha);
    }
  };
  for (const w of wants) walk(w);
  return out;
}

function parseTreeRaw(data: Buffer): { sha: string }[] {
  const out: { sha: string }[] = [];
  let i = 0;
  while (i < data.length) {
    const nul = data.indexOf(0x00, i);
    if (nul < 0) break;
    out.push({ sha: data.subarray(nul + 1, nul + 21).toString('hex') });
    i = nul + 21;
  }
  return out;
}

// ---- packfile encode ----

const TYPE_NUM: Record<GitObject['type'], number> = { commit: 1, tree: 2, blob: 3 };

export function buildPack(repo: Repo, shas: string[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(shas.length, 8);
  const body: Buffer[] = [header];
  for (const sha of shas) {
    const o = repo.objects.get(sha)!;
    body.push(packObjectHeader(TYPE_NUM[o.type], o.data.length), deflateSync(o.data));
  }
  const all = Buffer.concat(body);
  const checksum = createHash('sha1').update(all).digest();
  return Buffer.concat([all, checksum]);
}

function packObjectHeader(type: number, size: number): Buffer {
  const bytes: number[] = [];
  let b = (type << 4) | (size & 0x0f);
  size >>= 4;
  while (size > 0) {
    bytes.push(b | 0x80);
    b = size & 0x7f;
    size >>= 7;
  }
  bytes.push(b);
  return Buffer.from(bytes);
}

// ---- packfile decode (receive-pack) ----

interface RawObj { type: number; data: Buffer; }

export function unpackPack(pack: Buffer): Map<string, GitObject> {
  const objects = new Map<string, GitObject>();
  if (pack.length < 12 || pack.toString('ascii', 0, 4) !== 'PACK') return objects;
  const count = pack.readUInt32BE(8);
  let pos = 12;
  const byOffset = new Map<number, RawObj>();
  const resolveBase = (off: number): RawObj | undefined => byOffset.get(off);

  for (let n = 0; n < count; n++) {
    const start = pos;
    let c = pack[pos++];
    const type = (c >> 4) & 0x07;
    let size = c & 0x0f;
    let shift = 4;
    while (c & 0x80) { c = pack[pos++]; size |= (c & 0x7f) << shift; shift += 7; }
    if (type === 6) {
      // ofs-delta
      let b = pack[pos++];
      let ofs = b & 0x7f;
      while (b & 0x80) { b = pack[pos++]; ofs = ((ofs + 1) << 7) | (b & 0x7f); }
      const { out, consumed } = inflateFrom(pack, pos);
      pos += consumed;
      const base = resolveBase(start - ofs);
      if (base) {
        const applied = applyDelta(base.data, out);
        const obj: RawObj = { type: base.type, data: applied };
        byOffset.set(start, obj);
        store(objects, obj);
      }
    } else if (type === 7) {
      // ref-delta
      const baseSha = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const { out, consumed } = inflateFrom(pack, pos);
      pos += consumed;
      const base = findBase(objects, baseSha);
      if (base) {
        const applied = applyDelta(base.data, out);
        const t = { commit: 1, tree: 2, blob: 3 }[base.type]!;
        const obj: RawObj = { type: t, data: applied };
        byOffset.set(start, obj);
        store(objects, obj);
      }
    } else {
      const { out, consumed } = inflateFrom(pack, pos);
      pos += consumed;
      const obj: RawObj = { type, data: out };
      byOffset.set(start, obj);
      store(objects, obj);
    }
  }
  return objects;
}

const TYPE_NAME: Record<number, GitObject['type']> = { 1: 'commit', 2: 'tree', 3: 'blob' };

function store(objects: Map<string, GitObject>, raw: RawObj): void {
  const type = TYPE_NAME[raw.type];
  if (!type) return;
  const sha = Store.hashObject(type, raw.data);
  objects.set(sha, { type, data: raw.data });
}

function findBase(objects: Map<string, GitObject>, sha: string): GitObject | undefined {
  return objects.get(sha);
}

function inflateFrom(buf: Buffer, pos: number): { out: Buffer; consumed: number } {
  // Inflate a zlib stream of unknown compressed length: try growing windows.
  for (let end = pos + 16; end <= buf.length; end = Math.min(buf.length, end * 2)) {
    try {
      const slice = buf.subarray(pos, end);
      const out = inflateSync(slice);
      // zlib ignores trailing bytes; find real consumed by binary search down.
      let lo = pos, hi = end;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        try { inflateSync(buf.subarray(pos, mid)); hi = mid; } catch { lo = mid + 1; }
      }
      return { out, consumed: lo - pos };
    } catch {
      if (end >= buf.length) break;
    }
  }
  const out = inflateSync(buf.subarray(pos));
  return { out, consumed: buf.length - pos };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let p = 0;
  const readSize = (): number => {
    let size = 0, shift = 0, b: number;
    do { b = delta[p++]; size |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    return size;
  };
  readSize(); // base size
  const outSize = readSize();
  const out = Buffer.alloc(outSize);
  let o = 0;
  while (p < delta.length) {
    const op = delta[p++];
    if (op & 0x80) {
      let cpOff = 0, cpSize = 0;
      if (op & 0x01) cpOff |= delta[p++];
      if (op & 0x02) cpOff |= delta[p++] << 8;
      if (op & 0x04) cpOff |= delta[p++] << 16;
      if (op & 0x08) cpOff |= delta[p++] << 24;
      if (op & 0x10) cpSize |= delta[p++];
      if (op & 0x20) cpSize |= delta[p++] << 8;
      if (op & 0x40) cpSize |= delta[p++] << 16;
      if (cpSize === 0) cpSize = 0x10000;
      base.copy(out, o, cpOff, cpOff + cpSize);
      o += cpSize;
    } else if (op) {
      delta.copy(out, o, p, p + op);
      o += op;
      p += op;
    }
  }
  return out;
}

// ---- receive-pack v0 ----

export function receivePackAdvertise(repo: Repo): Buffer {
  const parts: Buffer[] = [];
  parts.push(pkt('# service=git-receive-pack\n'), FLUSH);
  const caps = 'report-status delete-refs side-band-64k ofs-delta agent=forge/0.1';
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pkt(`${'0'.repeat(40)} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach(([name, sha], idx) => {
      parts.push(pkt(idx === 0 ? `${sha} ${name}\0${caps}\n` : `${sha} ${name}\n`));
    });
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

interface RefUpdate { oldSha: string; newSha: string; ref: string; }

export function receivePack(repo: Repo, store: Store, body: Buffer): Buffer {
  const { lines, rest } = readPktLines(body);
  const updates: RefUpdate[] = [];
  for (const l of lines) {
    if (l === null || l.length === 0) continue;
    const s = l.toString('utf8');
    const nul = s.indexOf('\0');
    const cmd = (nul >= 0 ? s.slice(0, nul) : s).trim();
    const m = cmd.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (.+)$/);
    if (m) updates.push({ oldSha: m[1], newSha: m[2], ref: m[3] });
  }
  // The pack (if any) follows the flush; load its objects.
  if (rest.length > 0 && rest.toString('ascii', 0, 4) === 'PACK') {
    const objs = unpackPack(rest);
    for (const [sha, o] of objs) if (!repo.objects.has(sha)) repo.objects.set(sha, o);
  }
  // Apply with fast-forward enforcement; report per ref.
  const report: string[] = ['unpack ok\n'];
  for (const u of updates) {
    const zero = '0'.repeat(40);
    if (u.newSha === zero) {
      repo.refs.delete(u.ref);
      report.push(`ok ${u.ref}\n`);
      continue;
    }
    const cur = repo.refs.get(u.ref);
    const ff = !cur || isAncestor(repo, cur, u.newSha);
    if (cur && !ff) {
      report.push(`ng ${u.ref} non-fast-forward\n`);
    } else {
      repo.refs.set(u.ref, u.newSha);
      if (!repo.refs.has('HEAD')) repo.refs.set('HEAD', u.newSha);
      report.push(`ok ${u.ref}\n`);
    }
  }
  // side-band-64k report-status: band 1
  const reportBuf = Buffer.concat(report.map((r) => pkt(r)).concat([FLUSH]));
  const parts: Buffer[] = [];
  for (let i = 0; i < reportBuf.length; i += 65515) {
    parts.push(pkt(Buffer.concat([Buffer.from([1]), reportBuf.subarray(i, i + 65515)])));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const sha = stack.pop()!;
    if (sha === ancestor) return true;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const o = repo.objects.get(sha);
    if (o && o.type === 'commit') {
      for (const p of o.data.toString('utf8').matchAll(/^parent ([0-9a-f]{40})/gm)) stack.push(p[1]);
    }
  }
  return false;
}
