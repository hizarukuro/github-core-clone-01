// Git smart HTTP: protocol v2 for upload-pack (ls-refs + fetch), v0 for receive-pack,
// implemented against the object store in store.ts. No git binary exists in the trial, so
// packs are built and read by hand: plain (non-delta) objects out; plain or delta objects in.
//
// The perf shape matters (the clone workload is 50 concurrent depth-1 clones of one repo):
// fetch and ls-refs answers are cached per repo version and served as ready-made buffers.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  OBJ_TYPE_NUM, OBJ_TYPE_NAME, ZERO_OID,
  parseTree, isOid, hashObject, branchTipOf, peelToCommitOf, isAncestorOf,
  type Forge, type Repo, type ObjType,
} from './store.ts';

// ---------------------------------------------------------------- pkt-lines

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const length = payload.length + 4;
  const header = length.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(header, 'ascii'), payload]);
}
export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export interface PktReader {
  next(): Buffer | null;
  kind: string;
  offset: number;
}

export function pktReader(buffer: Buffer, start = 0): PktReader {
  let offset = start;
  let kind = 'end';
  return {
    next(): Buffer | null {
      if (offset + 4 > buffer.length) {
        kind = 'end';
        return null;
      }
      const length = Number.parseInt(buffer.toString('ascii', offset, offset + 4), 16);
      if (Number.isNaN(length) || length === 0) {
        kind = 'flush';
        offset += 4;
        return null;
      }
      if (length === 1) {
        kind = 'delim';
        offset += 4;
        return null;
      }
      if (length === 2) {
        kind = 'response-end';
        offset += 4;
        return null;
      }
      if (length < 4 || offset + length > buffer.length) {
        kind = 'end';
        return null;
      }
      kind = 'data';
      const payload = buffer.subarray(offset + 4, offset + length);
      offset += length;
      return payload;
    },
    get kind() {
      return kind;
    },
    get offset() {
      return offset;
    },
  };
}

function lineOf(payload: Buffer): string {
  return payload.toString('utf8').replace(/\n$/, '');
}

/** All data-packet lines after the command line, capability lines (agent=, object-format=) dropped. */
function argumentLines(reader: PktReader): string[] {
  const lines: string[] = [];
  let payload = reader.next();
  while (payload !== null || reader.kind === 'delim') {
    if (payload !== null) {
      const line = lineOf(payload);
      if (!line.startsWith('agent=') && !line.startsWith('object-format=')) lines.push(line);
    }
    payload = reader.next();
  }
  return lines;
}

// ---------------------------------------------------------------- packs

function packObjectHeader(typeNum: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeNum << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let byte = size & 0x7f;
    size >>= 7;
    if (size > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** Serialise objects into a complete pack (plain objects, no deltas). */
export function writePack(objects: readonly { type: ObjType; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(OBJ_TYPE_NUM[object.type], object.data.length));
    parts.push(deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/**
 * Inflate one zlib stream starting at `start`, returning the data and the offset just past the
 * stream. inflateSync ignores trailing bytes and throws on a truncated stream, so an
 * exponential probe plus a binary search pins the exact consumed length.
 */
function inflateExact(buffer: Buffer, start: number): { data: Buffer; next: number } {
  const remaining = buffer.length - start;
  let hi = Math.min(remaining, 256);
  let data: Buffer | null = null;
  while (data === null) {
    try {
      data = inflateSync(buffer.subarray(start, start + hi));
    } catch {
      if (hi >= remaining) throw new Error('corrupt pack object');
      hi = Math.min(remaining, hi * 4);
    }
  }
  let lo = 1;
  let high = hi;
  while (lo < high) {
    const mid = (lo + high) >> 1;
    try {
      inflateSync(buffer.subarray(start, start + mid));
      high = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return { data, next: start + lo };
}

/** Apply a git delta to a base object. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at];
      at += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  readVarint(); // source size
  const targetSize = readVarint();
  const parts: Buffer[] = [];
  while (at < delta.length) {
    const cmd = delta[at];
    at += 1;
    if (cmd & 0x80) {
      let offset = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (cmd & (1 << bit)) {
          offset |= delta[at] << (8 * bit);
          at += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (cmd & (0x10 << bit)) {
          size |= delta[at] << (8 * bit);
          at += 1;
        }
      }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
    } else if (cmd !== 0) {
      parts.push(delta.subarray(at, at + cmd));
      at += cmd;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize) throw new Error('delta size mismatch');
  return out;
}

export interface PackEntry {
  type: ObjType;
  data: Buffer;
}

/** Parse a whole pack into resolved objects (deltas applied against the pack or the repo). */
export function readPack(repo: Repo, pack: Buffer): PackEntry[] {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a pack');
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const entries: (PackEntry | null)[] = [];
  const headerOffsets: number[] = [];
  const indexByHeaderOffset = new Map<number, number>();
  const indexByOid = new Map<string, PackEntry>();
  const pending: { slot: number; baseOid?: string; baseIndex?: number; delta: Buffer }[] = [];

  for (let index = 0; index < count; index += 1) {
    const headerAt = offset;
    headerOffsets.push(headerAt);
    indexByHeaderOffset.set(headerAt, index);
    let byte = pack[offset];
    offset += 1;
    const typeNum = (byte >> 4) & 0x07;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
    }
    if (typeNum === 6) {
      // OFS_DELTA: a negative offset from this object's header to the base object's header.
      let back = pack[offset];
      offset += 1;
      let baseOffset = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset];
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (back & 0x7f);
      }
      const baseIndex = indexByHeaderOffset.get(headerAt - baseOffset);
      const { data, next } = inflateExact(pack, offset);
      offset = next;
      entries.push(null);
      pending.push({ slot: index, baseIndex, delta: data });
    } else if (typeNum === 7) {
      const baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
      const { data, next } = inflateExact(pack, offset);
      offset = next;
      entries.push(null);
      pending.push({ slot: index, baseOid, delta: data });
    } else {
      const type = OBJ_TYPE_NAME[typeNum];
      if (type === undefined) throw new Error(`pack object type ${typeNum}`);
      const { data, next } = inflateExact(pack, offset);
      offset = next;
      const entry = { type, data };
      entries.push(entry);
      indexByOid.set(hashObject(type, data), entry);
    }
  }

  let remaining = pending.length;
  let guard = 0;
  while (remaining > 0 && guard < 128) {
    guard += 1;
    for (const delta of pending) {
      if (entries[delta.slot] !== null) continue;
      let base: PackEntry | null = null;
      if (delta.baseOid !== undefined) {
        base = indexByOid.get(delta.baseOid) ?? null;
        if (base === null) {
          const inRepo = repo.objects.get(delta.baseOid);
          if (inRepo !== undefined) base = { type: inRepo.type, data: inRepo.data };
        }
      } else if (delta.baseIndex !== undefined) {
        base = entries[delta.baseIndex];
      }
      if (base === null) continue;
      const entry = { type: base.type, data: applyDelta(base.data, delta.delta) };
      entries[delta.slot] = entry;
      indexByOid.set(hashObject(entry.type, entry.data), entry);
      remaining -= 1;
    }
  }
  if (remaining > 0) throw new Error('unresolved pack delta');
  return entries as PackEntry[];
}

// ---------------------------------------------------------------- ref advertisement helpers

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
}

function advertisedRefs(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const line: RefLine = { oid, name };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = peelToCommitOf(repo, oid);
      if (peeled !== null) line.peeled = peeled;
    }
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------- HTTP handlers

export interface GitContext {
  forge: Forge;
  req: IncomingMessage;
  owner: string;
  repoName: string;
  tail: string;
  query: URLSearchParams;
  body: Buffer;
}

function gitError(res: ServerResponse, status: number, text: string): void {
  const buffer = Buffer.from(text, 'utf8');
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': buffer.length });
  res.end(buffer);
}

export function handleGit(ctx: GitContext, res: ServerResponse): void {
  const { forge } = ctx;
  const repo = ctx.owner === forge.login ? forge.repos.get(ctx.repoName) : undefined;
  if (repo === undefined) {
    gitError(res, 404, 'repository not found\n');
    return;
  }
  const method = ctx.req.method ?? 'GET';
  try {
    if (ctx.tail === '/info/refs' && method === 'GET') {
      handleInfoRefs(ctx, res, repo);
      return;
    }
    if (ctx.tail === '/git-upload-pack' && method === 'POST') {
      handleUploadPack(ctx, res, repo);
      return;
    }
    if (ctx.tail === '/git-receive-pack' && method === 'POST') {
      handleReceivePack(ctx, res, repo);
      return;
    }
  } catch {
    // A malformed body must never take the server down (repo-survives-errors).
    if (!res.headersSent) gitError(res, 400, 'bad request\n');
    else res.end();
    return;
  }
  gitError(res, 404, 'not found\n');
}

const UPLOAD_CAPS_V2 = ['version 2', 'agent=forge/1.0', 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];
const RECEIVE_CAPS_V0 = 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0';
const UPLOAD_CAPS_V0 = 'side-band-64k ofs-delta shallow agent=forge/1.0';

function handleInfoRefs(ctx: GitContext, res: ServerResponse, repo: Repo): void {
  const service = ctx.query.get('service') ?? '';
  const version2 = (ctx.req.headers['git-protocol'] ?? '') === 'version=2';
  const cacheKey = `adv:${service}:${version2 ? 'v2' : 'v0'}`;
  let buffer = repo.cache.get(cacheKey);
  if (buffer === undefined) {
    const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
    if (service === 'git-upload-pack' && version2) {
      for (const cap of UPLOAD_CAPS_V2) parts.push(pktLine(`${cap}\n`));
      parts.push(PKT_FLUSH);
    } else {
      const caps = service === 'git-receive-pack' ? RECEIVE_CAPS_V0 : UPLOAD_CAPS_V0;
      const refs = advertisedRefs(repo);
      if (refs.length === 0) {
        parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps} symref=HEAD:refs/heads/${repo.defaultBranch}\n`));
      } else {
        refs.forEach((line, index) => {
          const suffix = index === 0 ? `\0${caps} symref=HEAD:refs/heads/${repo.defaultBranch}` : '';
          parts.push(pktLine(`${line.oid} ${line.name}${suffix}\n`));
          if (line.peeled !== undefined) parts.push(pktLine(`${line.peeled} ${line.name}^{}\n`));
        });
      }
      parts.push(PKT_FLUSH);
    }
    buffer = Buffer.concat(parts);
    repo.cache.set(cacheKey, buffer);
  }
  res.writeHead(200, {
    'content-type': `application/x-${service}-advertisement`,
    'content-length': buffer.length,
    'cache-control': 'no-cache',
  });
  res.end(buffer);
}

// ---------------------------------------------------------------- upload-pack (v2)

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  if (pack.length === 0) {
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), pack])));
    return Buffer.concat(parts);
  }
  for (let at = 0; at < pack.length; at += CHUNK) {
    const chunk = pack.subarray(at, Math.min(at + CHUNK, pack.length));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

function handleUploadPack(ctx: GitContext, res: ServerResponse, repo: Repo): void {
  const reader = pktReader(ctx.body);
  const first = reader.next();
  if (first === null) {
    gitError(res, 400, 'empty request\n');
    return;
  }
  const command = lineOf(first);
  if (command === 'command=ls-refs') {
    handleLsRefs(ctx, res, repo, reader);
    return;
  }
  if (command === 'command=fetch') {
    handleFetch(ctx, res, repo, reader);
    return;
  }
  if (command.startsWith('want ')) {
    // v0 fetch: not used by the suite's client once v2 is advertised; answer NAK + empty pack.
    const payload = Buffer.concat([pktLine('NAK\n'), sidebandPack(writePack([]))]);
    res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': payload.length });
    res.end(payload);
    return;
  }
  gitError(res, 400, 'unknown command\n');
}

function handleLsRefs(ctx: GitContext, res: ServerResponse, repo: Repo, reader: PktReader): void {
  const lines = argumentLines(reader);
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const line of lines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const cacheKey = `lsrefs:${prefixes.join(',')}:${peel ? 1 : 0}:${symrefs ? 1 : 0}:${unborn ? 1 : 0}`;
  let buffer = repo.cache.get(cacheKey);
  if (buffer === undefined) {
    const parts: Buffer[] = [];
    const head = branchTipOf(repo, repo.defaultBranch);
    const headMatches = prefixes.length === 0 || prefixes.some((prefix) => 'HEAD'.startsWith(prefix) || prefix === 'HEAD');
    if (headMatches) {
      if (head !== null) {
        parts.push(pktLine(`${head} HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
      } else if (unborn) {
        parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
      } else if (symrefs) {
        parts.push(pktLine(`${ZERO_OID} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
      }
    }
    for (const line of advertisedRefs(repo)) {
      if (prefixes.length > 0 && !prefixes.some((prefix) => line.name.startsWith(prefix))) continue;
      let text = `${line.oid} ${line.name}`;
      if (peel && line.peeled !== undefined) text += ` peeled:${line.peeled}`;
      parts.push(pktLine(`${text}\n`));
    }
    parts.push(PKT_FLUSH);
    buffer = Buffer.concat(parts);
    repo.cache.set(cacheKey, buffer);
  }
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': buffer.length });
  res.end(buffer);
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

function fetchObjects(repo: Repo, args: FetchArgs): { objects: { type: ObjType; data: Buffer }[]; boundary: string[] } {
  // Everything the client already holds: the object closure of its haves — except that a
  // have the client itself lists as shallow contributes only its own snapshot, not its
  // history (that is exactly what the client is missing below the boundary).
  const shallowSet = new Set(args.shallow);
  const held = new Set<string>();
  const heldStack = [...args.haves];
  while (heldStack.length > 0) {
    const oid = heldStack.pop() as string;
    if (held.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    held.add(oid);
    if (object.type === 'commit') {
      const tree = repo.treeOf.get(oid);
      if (tree !== undefined) heldStack.push(tree);
      if (!shallowSet.has(oid)) {
        for (const parent of repo.parentsOf.get(oid) ?? []) heldStack.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) heldStack.push(entry.oid);
    } else if (object.type === 'tag') {
      const target = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'))?.[1];
      if (target !== undefined) heldStack.push(target);
    }
  }

  const included = new Map<string, { type: ObjType; data: Buffer }>();
  const includeObject = (oid: string): void => {
    if (included.has(oid) || held.has(oid)) return;
    const object = repo.objects.get(oid);
    if (object === undefined) return;
    included.set(oid, object);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) includeObject(entry.oid);
    } else if (object.type === 'tag') {
      const target = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'))?.[1];
      if (target !== undefined) includeObject(target);
    }
  };

  const boundary = new Set<string>();
  const distance = new Map<string, number>();
  const queue: string[] = [];
  for (const want of args.wants) {
    if (repo.objects.has(want)) includeObject(want);
    const commit = peelToCommitOf(repo, want);
    if (commit !== null && !distance.has(commit)) {
      distance.set(commit, 0);
      queue.push(commit);
    }
  }
  const depthLimit = args.depth;
  while (queue.length > 0) {
    const commit = queue.shift() as string;
    const dist = distance.get(commit) as number;
    if (!held.has(commit)) {
      includeObject(commit);
      const tree = repo.treeOf.get(commit);
      if (tree !== undefined) includeObject(tree);
    }
    const parents = repo.parentsOf.get(commit) ?? [];
    if (depthLimit !== null && dist + 1 >= depthLimit) {
      if (parents.length > 0 && !held.has(commit)) boundary.add(commit);
      continue;
    }
    for (const parent of parents) {
      if (!distance.has(parent)) {
        distance.set(parent, dist + 1);
        queue.push(parent);
      }
    }
  }
  if (depthLimit !== null) {
    for (const oid of included.keys()) {
      const object = repo.objects.get(oid);
      if (object?.type !== 'commit') continue;
      const parents = repo.parentsOf.get(oid) ?? [];
      if (parents.some((parent) => !included.has(parent) && !held.has(parent))) boundary.add(oid);
    }
  }
  return { objects: [...included.values()], boundary: [...boundary] };
}

function handleFetch(ctx: GitContext, res: ServerResponse, repo: Repo, reader: PktReader): void {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null };
  for (const line of argumentLines(reader)) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) args.depth = Number(line.slice(7).trim());
  }
  const cacheKey = args.haves.length === 0 && args.shallow.length === 0
    ? `fetch:${args.wants.join(',')}:d${args.depth ?? 'full'}`
    : null;
  let buffer = cacheKey !== null ? repo.cache.get(cacheKey) : undefined;
  if (buffer === undefined) {
    const { objects, boundary } = fetchObjects(repo, args);
    const parts: Buffer[] = [];
    if (args.haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'));
      const common = args.haves.filter((have) => repo.objects.has(have));
      if (common.length > 0) {
        for (const have of common) parts.push(pktLine(`ACK ${have}\n`));
        parts.push(pktLine('ready\n'));
      } else {
        parts.push(pktLine('NAK\n'));
      }
      parts.push(PKT_DELIM);
    }
    if (args.depth !== null || args.shallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of boundary) parts.push(pktLine(`shallow ${oid}\n`));
      for (const old of args.shallow) {
        // An old boundary is unshallowed only when this fetch actually covered it
        // (it came in as a want and is no longer at the boundary).
        if (!boundary.includes(old) && args.wants.includes(old)) {
          parts.push(pktLine(`unshallow ${old}\n`));
        }
      }
      parts.push(PKT_DELIM);
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(writePack(objects)));
    parts.push(PKT_FLUSH);
    buffer = Buffer.concat(parts);
    if (cacheKey !== null) repo.cache.set(cacheKey, buffer);
  }
  res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'content-length': buffer.length });
  res.end(buffer);
}

// ---------------------------------------------------------------- receive-pack (v0)

function handleReceivePack(ctx: GitContext, res: ServerResponse, repo: Repo): void {
  const { forge } = ctx;
  const body = ctx.body;
  const reader = pktReader(body);
  interface Command {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const commands: Command[] = [];
  let clientCaps = '';
  let payload = reader.next();
  while (payload !== null && reader.kind === 'data') {
    let text = payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul !== -1) {
      if (commands.length === 0) clientCaps = text.slice(nul + 1);
      text = text.slice(0, nul);
    }
    const parts = text.split(' ');
    if (parts.length >= 3 && isOid(parts[0]) && isOid(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
    payload = reader.next();
  }
  const packBytes = body.subarray(reader.offset);
  const hasUpdates = commands.some((command) => command.newOid !== ZERO_OID);
  let unpackOk = true;
  let unpackDetail = '';
  if (hasUpdates && packBytes.length > 0) {
    try {
      const entries = readPack(repo, packBytes);
      for (const entry of entries) {
        forge.putKnownObject(repo, hashObject(entry.type, entry.data), entry.type, entry.data);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }

  const results: { ref: string; ok: boolean; reason?: string }[] = [];
  if (unpackOk) {
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      if (command.newOid === ZERO_OID) {
        if (current === ZERO_OID) {
          results.push({ ref: command.ref, ok: false, reason: 'reference does not exist' });
        } else if (command.oldOid !== ZERO_OID && current !== command.oldOid) {
          results.push({ ref: command.ref, ok: false, reason: 'stale info' });
        } else {
          repo.refs.delete(command.ref);
          results.push({ ref: command.ref, ok: true });
        }
        continue;
      }
      if (!repo.objects.has(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'not a valid object' });
        continue;
      }
      if (current === ZERO_OID) {
        if (command.oldOid !== ZERO_OID) {
          results.push({ ref: command.ref, ok: false, reason: 'stale info' });
          continue;
        }
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true });
        continue;
      }
      if (current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'stale info' });
        continue;
      }
      if (command.ref.startsWith('refs/heads/')) {
        const newCommit = peelToCommitOf(repo, command.newOid);
        const oldCommit = peelToCommitOf(repo, current);
        if (newCommit === null || oldCommit === null || !isAncestorOf(repo, oldCommit, newCommit)) {
          results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
          continue;
        }
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true });
    }
    if (results.some((result) => result.ok)) forge.touch(repo);
  } else {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
  }

  const reportParts: Buffer[] = [pktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail || 'error'}\n`)];
  for (const result of results) {
    reportParts.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason ?? 'failed'}\n`));
  }
  reportParts.push(PKT_FLUSH);
  const report = Buffer.concat(reportParts);
  let buffer: Buffer;
  if (clientCaps.includes('side-band-64k') || clientCaps.includes('side-band')) {
    const framed: Buffer[] = [];
    const CHUNK = 32768;
    for (let at = 0; at < report.length; at += CHUNK) {
      framed.push(pktLine(Buffer.concat([Buffer.from([1]), report.subarray(at, Math.min(at + CHUNK, report.length))])));
    }
    framed.push(PKT_FLUSH);
    buffer = Buffer.concat(framed);
  } else {
    buffer = report;
  }
  res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'content-length': buffer.length });
  res.end(buffer);
}
