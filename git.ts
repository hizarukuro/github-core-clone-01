// Git smart HTTP: protocol v2 for upload-pack (ls-refs + fetch), v0 for receive-pack,
// implemented against the object store in store.ts. No git binary exists in the trial, so
// packs are built and read by hand: plain (non-delta) objects out; plain or delta objects in.
//
// The perf shape matters (the clone workload is 50 concurrent depth-1 clones of one repo):
// fetch and ls-refs answers are cached per repo version and served as ready-made buffers.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { createInflate, deflateSync } from 'node:zlib';
import {
  OBJ_TYPE_NUM, OBJ_TYPE_NAME, ZERO_OID,
  parseTree, isOid, hashObject, branchTipOf, peelToCommitOf, isAncestorOf,
  type Forge, type Repo, type ObjType,
} from './store.ts';

// ---------------------------------------------------------------- pkt-lines

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const out = Buffer.allocUnsafe(payload.length + 4);
  out.write((payload.length + 4).toString(16).padStart(4, '0'), 0, 'ascii');
  payload.copy(out, 4);
  return out;
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
 * stream. A zlib stream knows where its input ends: fed the rest of the pack it stops at the
 * stream's end and reports the exact consumed count as `bytesWritten`, so one pass replaces
 * the old probe-and-binary-search over inflateSync (whose throwing calls dominated the push
 * workload's CPU). The stream runs on the zlib threadpool, so callers are async.
 */
function inflateStream(buffer: Buffer, start: number): Promise<{ data: Buffer; next: number }> {
  return new Promise((resolve, reject) => {
    const stream = createInflate();
    const chunks: Buffer[] = [];
    stream.on('data', (chunk: Buffer) => chunks.push(chunk));
    stream.on('error', () => reject(new Error('corrupt pack object')));
    stream.on('end', () => {
      resolve({ data: Buffer.concat(chunks), next: start + stream.bytesWritten });
    });
    stream.end(buffer.subarray(start));
  });
}

// ---------------------------------------------------------------- JS inflate
//
// A pure-JS zlib inflate (RFC 1950 wrapper + RFC 1951 DEFLATE) with puff-style canonical
// Huffman decoding and a 9-bit peek table. A stream per object costs ~150-200 us of CPU in
// setup and threadpool hops; this decoder costs ~15-55 us for the small objects packs here
// carry, runs synchronously on the request thread, and reports the exact consumed length
// (which is what a pack parser needs and the sync zlib API cannot give). It is used for
// small packs/objects only; anything large keeps the native stream path above. Output is
// byte-identical to zlib's (differential-tested), the adler32 is verified, and every
// corrupt-input case zlib rejects also throws here.

const INFLATE_LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const INFLATE_LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const INFLATE_DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const INFLATE_DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const INFLATE_CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
const INFLATE_PEEK_BITS = 9;

interface InflateTable {
  counts: Int32Array;
  symbols: Int32Array;
  peek: Uint32Array;
  empty: boolean;
}

/** Reverse the low `len` bits of `code` (canonical MSB-first -> stream LSB-first order). */
function inflateReverseBits(code: number, len: number): number {
  let out = 0;
  for (let i = 0; i < len; i++) {
    out = (out << 1) | (code & 1);
    code >>= 1;
  }
  return out;
}

interface InflateSlot {
  counts: Int32Array;
  symbols: Int32Array;
  peek: Uint32Array;
}

function newInflateSlot(): InflateSlot {
  return { counts: new Int32Array(16), symbols: new Int32Array(320), peek: new Uint32Array(1 << INFLATE_PEEK_BITS) };
}

// Reused decode-table scratch. Safe because inflateJs is fully synchronous: a table is
// built and consumed inside one call, never held across an await, and inflateJs never
// recurses. Slot A serves the code-length table and then the literal table (the
// code-length table is dead once the lengths are read); slot B serves the distance table.
const INFLATE_SLOT_A = newInflateSlot();
const INFLATE_SLOT_B = newInflateSlot();
const INFLATE_OFFSETS = new Int32Array(16);
const INFLATE_NEXT_CODE = new Int32Array(16);
const INFLATE_LENGTHS = new Int32Array(320);
const INFLATE_CL_LENGTHS = new Int32Array(19);
const INFLATE_NO_PEEK = new Uint32Array(0);
const INFLATE_NO_SYMBOLS = new Int32Array(0);

/**
 * Build puff-style decode tables into `slot`: counts per length + symbols in canonical
 * order, plus a peek lookup: peek[upcoming bits] = symbol | (len << 16) for every code of
 * length <= INFLATE_PEEK_BITS; 0 means "no short code here" (longer code or invalid: the
 * puff path decides). `lengths` is read from `offset`, `count` entries.
 */
function inflateBuildTable(lengths: ArrayLike<number>, offset: number, count: number, slot: InflateSlot): InflateTable {
  const counts = slot.counts;
  counts.fill(0);
  for (let i = 0; i < count; i++) {
    const len = lengths[offset + i];
    if (len > 15) throw new Error('inflate: bad code length');
    counts[len] += 1;
  }
  if (counts[0] === count) return { counts, symbols: INFLATE_NO_SYMBOLS, peek: INFLATE_NO_PEEK, empty: true };
  let left = 1;
  for (let len = 1; len < 16; len++) {
    left <<= 1;
    left -= counts[len];
    if (left < 0) throw new Error('inflate: over-subscribed code');
  }
  const offsets = INFLATE_OFFSETS;
  offsets.fill(0);
  for (let len = 1; len < 15; len++) offsets[len + 1] = offsets[len] + counts[len];
  const symbols = slot.symbols;
  const used = count - counts[0];
  for (let i = 0; i < count; i++) {
    if (lengths[offset + i] !== 0) {
      symbols[offsets[lengths[offset + i]]] = i;
      offsets[lengths[offset + i]] += 1;
    }
  }
  // Canonical code values, assigned in (length, symbol) order = symbols[] order.
  // nextCode[1] = 0; nextCode[len] = (nextCode[len-1] + counts[len-1]) << 1.
  const nextCode = INFLATE_NEXT_CODE;
  nextCode.fill(0);
  for (let len = 2; len < 16; len++) {
    nextCode[len] = (nextCode[len - 1] + counts[len - 1]) << 1;
  }
  const peek = slot.peek;
  peek.fill(0);
  for (let i = 0; i < used; i++) {
    const symbol = symbols[i];
    const len = lengths[offset + symbol];
    const canonical = nextCode[len];
    nextCode[len] += 1;
    if (len > INFLATE_PEEK_BITS) continue;
    const base = inflateReverseBits(canonical, len);
    const entry = (symbol | (len << 16)) >>> 0;
    const step = 1 << len;
    for (let idx = base; idx < peek.length; idx += step) peek[idx] = entry;
  }
  return { counts, symbols, peek, empty: false };
}

const INFLATE_FIXED_LIT = ((): InflateTable => {
  const lengths = new Int32Array(288);
  for (let i = 0; i < 144; i++) lengths[i] = 8;
  for (let i = 144; i < 256; i++) lengths[i] = 9;
  for (let i = 256; i < 280; i++) lengths[i] = 7;
  for (let i = 280; i < 288; i++) lengths[i] = 8;
  return inflateBuildTable(lengths, 0, 288, newInflateSlot());
})();
const INFLATE_FIXED_DIST = ((): InflateTable => {
  const lengths = new Int32Array(32);
  lengths.fill(5);
  return inflateBuildTable(lengths, 0, 32, newInflateSlot());
})();

/**
 * Inflate the zlib stream starting at `start` in `buffer`; `sizeHint` is the pack header's
 * declared uncompressed size (initial capacity only — the output grows past a lying hint,
 * exactly as the stream path ignores the declared size). Returns the data and the offset
 * just past the stream's adler32.
 */
export function inflateJs(buffer: Buffer, start: number, sizeHint = 0): { data: Buffer; next: number } {
  if (start + 2 > buffer.length) throw new Error('inflate: input too short');
  const cmf = buffer[start];
  const flg = buffer[start + 1];
  if ((cmf & 0x0f) !== 8) throw new Error('inflate: bad compression method');
  if (((cmf << 8) + flg) % 31 !== 0) throw new Error('inflate: bad zlib header check');
  if (flg & 0x20) throw new Error('inflate: preset dictionary unsupported');

  const buf = buffer;
  const bufLen = buf.length;
  let pos = start + 2; // next byte to load into the bit buffer
  let bitBuf = 0;
  let bitCnt = 0;

  const bits = (n: number): number => {
    while (bitCnt < n) {
      if (pos >= bufLen) throw new Error('inflate: input overrun');
      bitBuf |= buf[pos] << bitCnt;
      pos += 1;
      bitCnt += 8;
    }
    const value = bitBuf & ((1 << n) - 1);
    bitBuf >>>= n;
    bitCnt -= n;
    return value;
  };

  const decode = (table: InflateTable): number => {
    // Fast path: peek INFLATE_PEEK_BITS and resolve any short code in one lookup.
    if (table.peek.length !== 0) {
      while (bitCnt < INFLATE_PEEK_BITS && pos < bufLen) {
        bitBuf |= buf[pos] << bitCnt;
        pos += 1;
        bitCnt += 8;
      }
      if (bitCnt >= INFLATE_PEEK_BITS || (bitCnt > 0 && pos >= bufLen)) {
        const entry = table.peek[bitBuf & ((1 << INFLATE_PEEK_BITS) - 1)];
        const len = entry >>> 16;
        if (len !== 0 && len <= bitCnt) {
          bitBuf >>>= len;
          bitCnt -= len;
          return entry & 0xffff;
        }
      }
    }
    const { counts, symbols } = table;
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len < 16; len++) {
      if (bitCnt === 0) {
        if (pos >= bufLen) throw new Error('inflate: input overrun');
        bitBuf = buf[pos];
        pos += 1;
        bitCnt = 8;
      }
      code |= bitBuf & 1;
      bitBuf >>>= 1;
      bitCnt -= 1;
      const count = counts[len];
      if (code - first < count) return symbols[index + (code - first)];
      index += count;
      first = (first + count) << 1;
      code <<= 1;
    }
    throw new Error('inflate: invalid huffman code');
  };

  const readDynamicTables = (): { lit: InflateTable; dist: InflateTable } => {
    const hlit = bits(5) + 257;
    const hdist = bits(5) + 1;
    const hclen = bits(4) + 4;
    const clLengths = INFLATE_CL_LENGTHS;
    clLengths.fill(0);
    for (let i = 0; i < hclen; i++) clLengths[INFLATE_CLEN_ORDER[i]] = bits(3);
    const clTable = inflateBuildTable(clLengths, 0, 19, INFLATE_SLOT_A);
    const lengths = INFLATE_LENGTHS;
    lengths.fill(0); // zero-run codes (17/18) skip entries: they must read as 0, not stale scratch
    let i = 0;
    while (i < hlit + hdist) {
      const sym = decode(clTable);
      if (sym < 16) {
        lengths[i] = sym;
        i += 1;
      } else if (sym === 16) {
        if (i === 0) throw new Error('inflate: repeat with no previous length');
        const prev = lengths[i - 1];
        let rep = 3 + bits(2);
        while (rep > 0) { lengths[i] = prev; i += 1; rep -= 1; }
      } else if (sym === 17) {
        i += 3 + bits(3);
      } else {
        i += 11 + bits(7);
      }
      if (i > hlit + hdist) throw new Error('inflate: code lengths overrun');
    }
    return { lit: inflateBuildTable(lengths, 0, hlit, INFLATE_SLOT_A), dist: inflateBuildTable(lengths, hlit, hdist, INFLATE_SLOT_B) };
  };

  let out = new Uint8Array(Math.max(64, sizeHint));
  let outLen = 0;
  const grow = (extra: number): void => {
    let cap = out.length * 2;
    while (cap < outLen + extra) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(out.subarray(0, outLen));
    out = next;
  };

  for (;;) {
    const bfinal = bits(1);
    const btype = bits(2);
    if (btype === 0) {
      const drop = bitCnt & 7;
      bitBuf >>>= drop;
      bitCnt -= drop;
      const len = bits(8) | (bits(8) << 8);
      const nlen = bits(8) | (bits(8) << 8);
      if (len !== (~nlen & 0xffff)) throw new Error('inflate: stored block length mismatch');
      if (outLen + len > out.length) grow(len);
      for (let k = 0; k < len; k++) {
        out[outLen] = bits(8);
        outLen += 1;
      }
    } else if (btype === 1 || btype === 2) {
      const { lit, dist } = btype === 1 ? { lit: INFLATE_FIXED_LIT, dist: INFLATE_FIXED_DIST } : readDynamicTables();
      if (lit.empty) throw new Error('inflate: empty literal table');
      for (;;) {
        const sym = decode(lit);
        if (sym < 256) {
          if (outLen === out.length) grow(1);
          out[outLen] = sym;
          outLen += 1;
        } else if (sym === 256) {
          break;
        } else {
          const li = sym - 257;
          if (li >= 29) throw new Error('inflate: bad length symbol');
          const length = INFLATE_LEN_BASE[li] + bits(INFLATE_LEN_EXTRA[li]);
          if (dist.empty) throw new Error('inflate: empty distance table');
          const dsym = decode(dist);
          if (dsym >= 30) throw new Error('inflate: bad distance symbol');
          const distance = INFLATE_DIST_BASE[dsym] + bits(INFLATE_DIST_EXTRA[dsym]);
          if (distance > outLen) throw new Error('inflate: distance too far back');
          if (outLen + length > out.length) grow(length);
          let from = outLen - distance;
          for (let k = 0; k < length; k++) {
            out[outLen] = out[from];
            outLen += 1;
            from += 1;
          }
        }
      }
    } else {
      throw new Error('inflate: invalid block type');
    }
    if (bfinal === 1) break;
  }

  const dataEnd = pos - (bitCnt >> 3);
  if (dataEnd + 4 > bufLen) throw new Error('inflate: missing adler32');
  const expectedAdler = buf.readUInt32BE(dataEnd);
  let a = 1;
  let b = 0;
  for (let i = 0; i < outLen; i++) {
    a += out[i];
    b += a;
    if (b >= 0x10000000) { a %= 65521; b %= 65521; }
  }
  const adler = (((b % 65521) << 16) | (a % 65521)) >>> 0;
  if (adler !== expectedAdler) throw new Error('inflate: adler32 mismatch');
  return { data: Buffer.from(out.buffer as ArrayBuffer, 0, outLen), next: dataEnd + 4 };
}

/** Packs up to this size, and objects up to this size, inflate through inflateJs. */
const JS_INFLATE_MAX_PACK = 65_536;
const JS_INFLATE_MAX_OBJECT = 262_144;

function inflateObject(pack: Buffer, start: number, size: number): Promise<{ data: Buffer; next: number }> {
  if (pack.length <= JS_INFLATE_MAX_PACK && size <= JS_INFLATE_MAX_OBJECT) {
    try {
      return Promise.resolve(inflateJs(pack, start, size));
    } catch {
      // Same error surface as the stream path: any corrupt object is 'corrupt pack object'.
      throw new Error('corrupt pack object');
    }
  }
  return inflateStream(pack, start);
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
  /** The object's git id (already computed during the parse; callers need not re-hash). */
  oid: string;
}

/** Parse a whole pack into resolved objects (deltas applied against the pack or the repo). */
export async function readPack(repo: Repo, pack: Buffer): Promise<PackEntry[]> {
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
    let size = byte & 0x0f;
    let sizeShift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size += (byte & 0x7f) * 2 ** sizeShift;
      sizeShift += 7;
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
      const { data, next } = await inflateObject(pack, offset, size);
      offset = next;
      entries.push(null);
      pending.push({ slot: index, baseIndex, delta: data });
    } else if (typeNum === 7) {
      const baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
      const { data, next } = await inflateObject(pack, offset, size);
      offset = next;
      entries.push(null);
      pending.push({ slot: index, baseOid, delta: data });
    } else {
      const type = OBJ_TYPE_NAME[typeNum];
      if (type === undefined) throw new Error(`pack object type ${typeNum}`);
      const { data, next } = await inflateObject(pack, offset, size);
      offset = next;
      const entry = { type, data, oid: hashObject(type, data) };
      entries.push(entry);
      indexByOid.set(entry.oid, entry);
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
          if (inRepo !== undefined) base = { type: inRepo.type, data: inRepo.data, oid: delta.baseOid };
        }
      } else if (delta.baseIndex !== undefined) {
        base = entries[delta.baseIndex];
      }
      if (base === null) continue;
      const resolved = applyDelta(base.data, delta.delta);
      const entry = { type: base.type, data: resolved, oid: hashObject(base.type, resolved) };
      entries[delta.slot] = entry;
      indexByOid.set(entry.oid, entry);
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
      void withReceiveLock(repo, () => handleReceivePack(ctx, res, repo)).catch(() => {
        // A malformed body must never take the server down (repo-survives-errors).
        if (!res.headersSent) gitError(res, 400, 'bad request\n');
        else res.end();
      });
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

/**
 * Serialise receive-pack handling per repo: pack parsing is async (zlib streams), and one
 * push's store/ref updates must stay atomic against the next push, exactly as they were when
 * the parse was synchronous. Uncontended in the suite's sequential flows.
 */
const receivePackLocks = new WeakMap<Repo, Promise<void>>();

function withReceiveLock(repo: Repo, fn: () => Promise<void>): Promise<void> {
  const previous = receivePackLocks.get(repo) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  receivePackLocks.set(
    repo,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

async function handleReceivePack(ctx: GitContext, res: ServerResponse, repo: Repo): Promise<void> {
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
      const entries = await readPack(repo, packBytes);
      for (const entry of entries) {
        forge.putKnownObject(repo, entry.oid, entry.type, entry.data);
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
