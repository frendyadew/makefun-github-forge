// Git smart HTTP (protocol v0 + v2) and pack handling for the forge.
// Serves `/{owner}/{repo}.git/info/refs?service=...`, `git-upload-pack` and
// `git-receive-pack`. Objects live in the Store; packs are written and read
// with the git packfile format (v2, no deltas by default, trailer SHA-1).

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { Store } from './store.ts';

const ZERO_OID = '0000000000000000000000000000000000000000';
const PKT_LINE_MAX_PAYLOAD = 65520;
const TYPE_CODE: Readonly<Record<string, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, string>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function sha1Hex(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex');
}

function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** Encode one pkt-line: 4-hex length (payload + 4) then payload. */
export function encodePktLine(payload: string | Uint8Array): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  if (data.length > PKT_LINE_MAX_PAYLOAD) throw new Error('pkt-line too long');
  const header = Buffer.allocUnsafe(4);
  header.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([header, data]);
}

const FLUSH = Buffer.from('0000', 'ascii');
export { FLUSH };
const DELIM = Buffer.from('0001', 'ascii');

function encodePktLines(items: ReadonlyArray<string | Uint8Array | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(encodePktLine(item));
  }
  return Buffer.concat(parts);
}

function parsePktLines(bytes: Buffer): { kind: 'data' | 'flush' | 'delim'; payload: Buffer }[] {
  const out: { kind: 'data' | 'flush' | 'delim'; payload: Buffer }[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const len = Number.parseInt(bytes.subarray(offset, offset + 4).toString('ascii'), 16);
    if (len === 0) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); offset += 4; continue; }
    if (len === 1) { out.push({ kind: 'delim', payload: Buffer.alloc(0) }); offset += 4; continue; }
    if (len === 2) { out.push({ kind: 'flush', payload: Buffer.alloc(0) }); offset += 4; continue; }
    if (offset + len > bytes.length) break;
    out.push({ kind: 'data', payload: bytes.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return out;
}

/** Build a packfile from plain objects. Header PACK v2, entries, SHA-1 trailer. */
export function writePack(objects: { type: string; data: Uint8Array }[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const data = Buffer.from(object.data);
    parts.push(writePackObjectHeader(object.type, data.length));
    parts.push(deflateSync(data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function writePackObjectHeader(type: string, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  if (start >= buffer.length) throw new Error('pack entry has no size header');
  let byte = buffer[start];
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('pack entry size varint is truncated');
    byte = buffer[offset++];
    size += (byte & 0x7f) * (1 << shift);
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  if (start >= buffer.length) throw new Error('ofs-delta has no base offset');
  let byte = buffer[start];
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    if (offset >= buffer.length) throw new Error('ofs-delta base offset is truncated');
    byte = buffer[offset++];
    value = ((value + 1) * 128) + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Uint8Array, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  let result: { buffer: Buffer; engine: { bytesWritten: number } };
  try {
    result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  } catch (err) {
    throw new Error(`zlib stream at offset ${offset} did not inflate`);
  }
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const deltaBuffer = delta;
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= deltaBuffer.length) throw new Error('delta size varint is truncated');
      const byte = deltaBuffer[offset++];
      value += (byte & 0x7f) * (1 << shift);
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy offset is truncated');
          copyOffset += deltaBuffer[offset++] * (1 << shift);
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (offset >= deltaBuffer.length) throw new Error('delta copy size is truncated');
          copySize += deltaBuffer[offset++] * (1 << shift);
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

/** Parse a git tree object into entries. */
export function parseTree(data: Uint8Array): { mode: string; name: string; oid: string }[] {
  const buffer = Buffer.from(data);
  const entries: { mode: string; name: string; oid: string }[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree entry has no mode separator');
    const nul = buffer.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('tree entry has no name terminator');
    if (nul + 21 > buffer.length) throw new Error('tree entry has a truncated object id');
    entries.push({
      mode: buffer.subarray(offset, space).toString('ascii'),
      name: buffer.subarray(space + 1, nul).toString('utf8'),
      oid: buffer.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Parse a git commit object. */
export function parseCommit(data: Uint8Array): { tree: string; parents: string[]; author: string; committer: string; message: string } {
  const buffer = Buffer.from(data);
  const blank = buffer.indexOf('\n\n');
  const headerEnd = blank < 0 ? buffer.length : blank;
  const headerText = buffer.subarray(0, headerEnd).toString('utf8');
  const message = blank < 0 ? '' : buffer.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of headerText.split('\n')) {
    if (!line) continue;
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  return { tree, parents, author, committer, message };
}

/** Collect all objects reachable from tips via commit/tree traversal. */
export function collectReachable(store: Store, tips: string[]): string[] {
  const seen = new Set<string>();
  const stack = [...tips.filter((t) => t !== ZERO_OID)];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const obj = store.getObject(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      for (const p of c.parents) if (!seen.has(p)) stack.push(p);
      stack.push(c.tree);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (!seen.has(entry.oid)) stack.push(entry.oid);
      }
    } else if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const m = /^object ([0-9a-f]{40})/m.exec(text);
      if (m) stack.push(m[1]);
    }
  }
  return [...seen];
}

/** Read a packfile (v2/v3) and resolve every object. */
export function readPack(pack: Buffer, store: Store): Map<string, { type: string; data: Buffer }> {
  const buffer = pack;
  if (buffer.length < 32) throw new Error('pack too short');
  if (buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = buffer.readUInt32BE(8);
  const trailerStart = buffer.length - 20;
  const computed = sha1Hex(buffer.subarray(0, trailerStart));
  const actual = buffer.subarray(trailerStart).toString('hex');
  if (computed !== actual) throw new Error('pack trailer mismatch');

  interface RawEntry {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
    resolvedType?: string;
    resolved?: Buffer;
    oid?: string;
  }

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let index = 0; index < declaredCount; index += 1) {
    const entryOffset = offset;
    const header = readVarintSize(buffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const base = readOfsDeltaBase(buffer, offset);
      offset = base.next;
      entry.baseOffset = entryOffset - base.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type code ${typeCode}`);
    }
    const inflated = inflateAt(buffer.subarray(0, trailerStart), offset);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const objects = new Map<string, { type: string; data: Buffer }>();
  const resolvedByOid = new Map<string, RawEntry>();

  const resolve = (entry: RawEntry): { type: string; data: Buffer; oid: string } => {
    if (entry.resolved && entry.resolvedType && entry.oid) return { type: entry.resolvedType, data: entry.resolved, oid: entry.oid };
    let type: string;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base not in pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const wanted = entry.baseOid!;
      const baseEntry = resolvedByOid.get(wanted);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = store.getObject(wanted);
        if (!external) throw new Error(`ref-delta base ${wanted} not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = sha1Hex(concatBuffers(new TextEncoder().encode(`${type} ${data.length}\0`), data));
    entry.resolved = data;
    entry.resolvedType = type;
    entry.oid = oid;
    resolvedByOid.set(oid, entry);
    return { type, data, oid };
  };

  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

function concatBuffers(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// ----------------------------------------------------------------------
// Smart HTTP request handlers
// ----------------------------------------------------------------------

export interface UploadPackAdvertisement {
  refs: { oid: string; name: string; peeled?: string; symrefTarget?: string }[];
  capabilities: Map<string, string>;
  headSymref: string | null;
}

export class GitService {
  private readonly store: Store;
  constructor(store: Store) {
    this.store = store;
  }

  /** Build a v2 upload-pack advertisement: `version 2\n` + capability lines. */
  advertiseV2(owner: string, repo: string): UploadPackAdvertisement {
    const refs = this.store.listRefs(owner, repo);
    const entries: { oid: string; name: string; peeled?: string; symrefTarget?: string }[] = [];
    let headSymref: string | null = null;
    const headOid = refs.get('HEAD');
    const headTarget = headOid ? `ref: refs/heads/main` : null;

    // HEAD symref
    entries.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: 'refs/heads/main' });
    headSymref = 'refs/heads/main';

    // All refs (excluding HEAD which is a symref)
    for (const [name, oid] of refs) {
      if (name === 'HEAD') continue;
      entries.push({ oid, name });
      // Peeling: if the ref points to a tag, try to peel
      const obj = this.store.getObject(oid);
      if (obj && obj.type === 'tag') {
        const text = obj.data.toString('utf8');
        const m = /^object ([0-9a-f]{40})\n/m.exec(text);
        if (m) entries.push({ oid, name: `${name}^{}`, peeled: m[1] });
      }
    }

    const capabilities = new Map<string, string>([
      ['fetch', 'shallow'],
      ['ls-refs', 'peel symrefs unborn ref-prefix'],
      ['object-format', 'sha1'],
      ['agent', 'forge/1.0'],
    ]);

    return { refs: entries, capabilities, headSymref };
  }

  /** Build a v0 advertisement body (pkt-lined): `<oid> name\0caps\n` lines. */
  advertiseV0(owner: string, repo: string, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
    const refs = this.store.listRefs(owner, repo);
    const lines: Buffer[] = [];
    let first = true;

    const capsUploadPack = 'multi_ack_detailed side-band-64k ofs-delta thin-pack shallow no-progress agent=forge/1.0';
    const capsReceivePack = 'report-status side-band-64k ofs-delta delete-refs report-status-v2 agent=forge/1.0';

    for (const [name, oid] of refs) {
      const caps = first ? `\0${name === 'HEAD' || service === 'git-upload-pack' ? capsUploadPack : capsReceivePack}` : '';
      lines.push(encodePktLine(`${oid} ${name}${caps}\n`));
      first = false;
      // Peeled tags
      const obj = this.store.getObject(oid);
      if (obj && obj.type === 'tag') {
        const text = obj.data.toString('utf8');
        const m = /^object ([0-9a-f]{40})\n/m.exec(text);
        if (m) lines.push(encodePktLine(`${m[1]} ${name}^{}\n`));
      }
    }

    // Empty repo: capabilities^{} pseudo-ref
    if (refs.size === 0 || !refs.has('HEAD') || (refs.size === 1 && refs.has('HEAD'))) {
      const caps = ` \0${service === 'git-upload-pack' ? capsUploadPack : capsReceivePack}`;
      lines.push(encodePktLine(`${ZERO_OID} capabilities^{}${caps}\n`));
    }

    const preamble = encodePktLine(`# service=${service}\n`);
    const flush = FLUSH;
    return Buffer.concat([preamble, ...lines, flush]);
  }

  // ------------------------------------------------------------------
  // v2 fetch
  // ------------------------------------------------------------------

  handleV2Fetch(owner: string, repo: string, body: Buffer): { status: number; body: Buffer } {
    const packets = parsePktLines(body);
    const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));

    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    let done = true;

    for (const line of lines) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
      else if (line === 'done') done = true;
    }

    const refs = this.store.listRefs(owner, repo);

    const out: Buffer[] = [];

    // Objects reachable from wants that the client does not already hold (haves + their reachable closure).
    // Honor `depth`: only that many commit generations are sent.
    // For shallow clients, limit haveReachable to depth 1 (the shallow clone depth).
    let wantReachable: string[];
    let wantBoundaries: string[];
    if (depth != null) {
      const result = this.store.collectReachableWithDepth(wants, depth);
      wantReachable = result.oids;
      wantBoundaries = result.boundaries;
    } else {
      wantReachable = collectReachable(this.store, wants);
      wantBoundaries = [];
    }

    // acknowledgments section
    const ackLines: string[] = ['acknowledgments\n'];
    const held = new Set(haves);
    const newWants = wants.filter((w) => !held.has(w));
    if (newWants.length === 0) {
      ackLines.push('NAK\n');
    } else {
      for (const w of newWants) ackLines.push(`ACK ${w}\n`);
      ackLines.push('NAK\n');
    }
    out.push(encodePktLines([...ackLines, 'flush']));

    // shallow-info section (only if shallow requested)
    if (shallow.length > 0 || depth != null) {
      const shallowLines: string[] = ['shallow-info\n'];
      // Unshallow old shallow boundaries that are now within depth
      for (const s of shallow) {
        if (wantReachable.includes(s)) shallowLines.push(`unshallow ${s}\n`);
      }
      // New shallow boundaries at the depth edge
      for (const b of wantBoundaries) shallowLines.push(`shallow ${b}\n`);
      out.push(encodePktLines([...shallowLines, 'flush']));
    }

    // wanted-refs section
    const wantedRefsLines: string[] = ['wanted-refs\n'];
    for (const [name, oid] of refs) {
      if (wants.includes(oid)) wantedRefsLines.push(`${oid} ${name}\n`);
    }
    out.push(encodePktLines([...wantedRefsLines, 'flush']));

    // packfile section
    const packLines: Buffer[] = [];
    packLines.push(encodePktLine('packfile\n'));
    const sendOids: string[] = [];
    let haveReachable: Set<string>;
    if (shallow.length > 0) {
      haveReachable = new Set(this.store.collectReachableWithDepth(haves, 1).oids);
    } else {
      haveReachable = new Set(collectReachable(this.store, haves));
    }
    for (const oid of wantReachable) {
      if (!haveReachable.has(oid) && !sendOids.includes(oid)) sendOids.push(oid);
    }

    const packObjects: { type: string; data: Uint8Array }[] = [];
    for (const oid of sendOids) {
      const obj = this.store.getObject(oid);
      if (obj) packObjects.push({ type: obj.type, data: obj.data });
    }

    let pack: Buffer | null = null;
    if (packObjects.length > 0) {
      pack = writePack(packObjects);
    }
    if (pack) {
      const chunkSize = 4096;
      for (let i = 0; i < pack.length; i += chunkSize) {
        const chunk = pack.subarray(i, i + chunkSize);
        packLines.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
      }
    }
    packLines.push(FLUSH);
    out.push(Buffer.concat(packLines));

    const bodyOut = Buffer.concat(out);
    return { status: 200, body: bodyOut };
  }

  // ------------------------------------------------------------------
  // v0 fetch
  // ------------------------------------------------------------------

  handleV0Fetch(owner: string, repo: string, body: Buffer): { status: number; body: Buffer } {
    const packets = parsePktLines(body);
    const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));

    const wants: string[] = [];
    const haves: string[] = [];
    let depth: number | null = null;
    let shallowBoundaries: string[] = [];

    let inSecondSection = false;
    for (const line of lines) {
      if (line === 'flush') { inSecondSection = true; continue; }
      if (inSecondSection) {
        if (line.startsWith('have ')) haves.push(line.slice(5).trim());
        else if (line === 'done') done;
      } else {
        if (line.startsWith('want ')) wants.push(line.slice(5).trim());
        else if (line.startsWith('shallow ')) shallowBoundaries.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7).trim(), 10);
      }
    }

    const held = new Set(haves);
    const newWants = wants.filter((w) => !held.has(w));

    const packChunks: Buffer[] = [];
    const sendOids: string[] = [];
    let wantReachable: string[];
    let wantBoundaries: string[];
    if (depth != null) {
      const result = this.store.collectReachableWithDepth(newWants, depth);
      wantReachable = result.oids;
      wantBoundaries = result.boundaries;
    } else {
      wantReachable = collectReachable(this.store, newWants);
      wantBoundaries = [];
    }
    let haveReachable: Set<string>;
    if (shallowBoundaries.length > 0) {
      haveReachable = new Set(this.store.collectReachableWithDepth(haves, 1).oids);
    } else {
      haveReachable = new Set(collectReachable(this.store, haves));
    }
    for (const oid of wantReachable) {
      if (!haveReachable.has(oid) && !sendOids.includes(oid)) sendOids.push(oid);
    }

    const packObjects: { type: string; data: Uint8Array }[] = [];
    for (const oid of sendOids) {
      const obj = this.store.getObject(oid);
      if (obj) packObjects.push({ type: obj.type, data: obj.data });
    }

    let pack: Buffer | null = null;
    if (packObjects.length > 0) pack = writePack(packObjects);

    const out: Buffer[] = [];
    // NAK or ACKs
    if (newWants.length === 0) {
      out.push(encodePktLine('NAK\n'));
    } else {
      for (const w of newWants) out.push(encodePktLine(`ACK ${w}\n`));
      out.push(encodePktLine('NAK\n'));
    }

    // shallow-info: unshallow old shallow boundaries, shallow new boundaries
    if (shallowBoundaries.length > 0 || depth != null) {
      for (const s of shallowBoundaries) {
        if (wantReachable.includes(s)) out.push(encodePktLine(`unshallow ${s}\n`));
      }
      for (const b of wantBoundaries) out.push(encodePktLine(`shallow ${b}\n`));
    }

    // Sideband packets for pack data
    if (pack) {
      const chunkSize = 4096;
      for (let i = 0; i < pack.length; i += chunkSize) {
        const chunk = pack.subarray(i, i + chunkSize);
        out.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
      }
    }
    out.push(FLUSH);

    return { status: 200, body: Buffer.concat(out) };
  }

  // ------------------------------------------------------------------
  // v2 ls-refs
  // ------------------------------------------------------------------

  handleLsRefs(owner: string, repo: string, body: Buffer): { status: number; body: Buffer } {
    const packets = parsePktLines(body);
    const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8'));

    const prefixes: string[] = [];
    let peel = false;
    let symrefs = false;
    for (const line of lines) {
      if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11).trim());
      else if (line === 'peel\n') peel = true;
      else if (line === 'symrefs\n') symrefs = true;
    }

    const refs = this.store.listRefs(owner, repo);
    const out: Buffer[] = [];

    const emit = (entries: { oid: string; name: string; peeled?: string; symrefTarget?: string }[]) => {
      const lines: string[] = [];
      for (const e of entries) {
        let line = `${e.oid} ${e.name}`;
        if (e.symrefTarget) line += ` symref-target:${e.symrefTarget}`;
        if (e.peeled) line += ` peeled:${e.peeled}`;
        lines.push(line);
      }
      out.push(encodePktLines([...lines, 'flush']));
    };

    const all: { oid: string; name: string; peeled?: string; symrefTarget?: string }[] = [];
    // HEAD symref
    all.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: 'refs/heads/main' });
    for (const [name, oid] of refs) {
      if (name === 'HEAD') continue;
      const entry: { oid: string; name: string; peeled?: string; symrefTarget?: string } = { oid, name };
      const obj = this.store.getObject(oid);
      if (obj && obj.type === 'tag') {
        const text = Buffer.from(obj.data).toString('utf8');
        const m = /^object ([0-9a-f]{40})\n/m.exec(text);
        if (m) entry.peeled = m[1];
        else console.error('[ls-refs] tag no object match:', name, oid, JSON.stringify(text.slice(0, 60)));
      } else if (obj) {
        console.error('[ls-refs] non-tag object:', name, oid, obj.type);
      } else {
        console.error('[ls-refs] object not stored:', name, oid);
      }
      all.push(entry);
    }

    if (prefixes.length > 0) {
      for (const prefix of prefixes) {
        const filtered = all.filter((e) => e.name.startsWith(prefix));
        emit(filtered);
      }
    } else {
      console.error('[ls-refs] entries:', JSON.stringify(all.map(e => ({name:e.name, oid:e.oid, peeled:e.peeled}))));
      emit(all);
    }

    return { status: 200, body: Buffer.concat(out) };
  }

  // ------------------------------------------------------------------
  // receive-pack push
  // ------------------------------------------------------------------

  handleReceivePack(owner: string, repo: string, body: Buffer): { status: number; body: Buffer } {
    // Split body into pkt-line command section + pack.
    // Walk pkt-lines tracking byte offsets; pack bytes follow the flush packet.
    const packets = parsePktLines(body);
    let packBytes = Buffer.alloc(0);
    const commands: { oldOid: string; newOid: string; ref: string; capabilities: Map<string, string> }[] = [];

    let offset = 0;
    let foundFlush = false;
    for (let i = 0; i < packets.length; i += 1) {
      const p = packets[i];
      const rawLen = p.kind === 'flush' || p.kind === 'delim' ? 4 : 4 + p.payload.length;
      if (p.kind === 'flush') {
        packBytes = body.subarray(offset + rawLen);
        foundFlush = true;
        break;
      }
      offset += rawLen;
      if (p.kind !== 'data') continue;
      const line = p.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const commandPart = nul >= 0 ? line.slice(0, nul) : line;
      const capsPart = nul >= 0 ? line.slice(nul + 1) : '';
      const parts = commandPart.split(' ');
      if (parts.length < 3) continue;
      const oldOid = parts[0];
      const newOid = parts[1];
      const ref = parts[2];
      const caps = new Map<string, string>();
      for (const token of capsPart.split(' ')) {
        if (!token) continue;
        const eq = token.indexOf('=');
        if (eq < 0) caps.set(token, '');
        else caps.set(token.slice(0, eq), token.slice(eq + 1));
      }
      commands.push({ oldOid, newOid, ref, capabilities: caps });
    }

    if (!foundFlush) packBytes = Buffer.alloc(0);

    // Process commands
    const reportLines: string[] = [];

    // Unpack the pack if present
    let unpackOk = true;
    let unpackDetail = 'ok';
    if (packBytes.length > 0) {
      try {
        const newObjects = readPack(packBytes, this.store);
        for (const [oid, obj] of newObjects) {
          if (!this.store.getObject(oid)) this.store.put(obj.type as any, obj.data);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : String(err);
        console.error('[receive-pack] unpack error:', unpackDetail);
      }
    }

    reportLines.push(`unpack ${unpackOk ? 'ok' : 'failed'}\n`);

    for (const cmd of commands) {
      if (cmd.newOid === ZERO_OID) {
        const current = this.store.getRef(owner, repo, cmd.ref);
        if (current === cmd.oldOid || current === undefined) {
          this.store.deleteRef(owner, repo, cmd.ref);
          reportLines.push(`ok ${cmd.ref}\n`);
        } else {
          reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        }
      } else {
        const current = this.store.getRef(owner, repo, cmd.ref);
        if (current === undefined || current === ZERO_OID) {
          this.store.setRef(owner, repo, cmd.ref, cmd.newOid);
          reportLines.push(`ok ${cmd.ref}\n`);
        } else if (current === cmd.oldOid) {
          if (this.isAncestor(owner, repo, cmd.oldOid, cmd.newOid)) {
            this.store.setRef(owner, repo, cmd.ref, cmd.newOid);
            reportLines.push(`ok ${cmd.ref}\n`);
          } else {
            reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
          }
        } else {
          reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        }
      }
    }

    // report-status is pkt-line framed, each packet carries band-1 sideband data
    const reportBody = Buffer.concat(reportLines.map((l) =>
      encodePktLine(Buffer.concat([Buffer.from([1]), Buffer.from(l, 'utf8')])),
    ));
    return { status: 200, body: reportBody };
  }

  /** Whether `ancestor` is an ancestor of `oid` in this repo. */
  private isAncestor(owner: string, repo: string, ancestor: string, oid: string): boolean {
    if (ancestor === oid) return true;
    const visited = new Set<string>();
    const stack = [oid];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur === ancestor) return true;
      if (visited.has(cur)) continue;
      visited.add(cur);
      const obj = this.store.getObject(cur);
      if (!obj) continue;
      if (obj.type === 'commit') {
        for (const p of parseCommit(obj.data).parents) stack.push(p);
      }
    }
    return false;
  }
}
