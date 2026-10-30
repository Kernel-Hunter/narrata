// Piper's ONNX export returns only the audio. Word highlighting needs the length of each phoneme,
// which the graph computes (the rounded-up output of the duration predictor, its only Ceil node)
// but does not return. This adds that tensor to the graph's outputs by editing the protobuf
// directly: ModelProto.graph (field 7) gets one more GraphProto.output (field 12).

function readVarint(b: Uint8Array, pos: number): [number, number] {
  let v = 0;
  let mul = 1;
  for (;;) {
    const x = b[pos++];
    v += (x & 0x7f) * mul;
    if (x < 0x80) return [v, pos];
    mul *= 128;
  }
}

function varint(n: number): number[] {
  const out: number[] = [];
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

interface Field {
  no: number;
  wire: number;
  /** Start of the tag, start and end of the value (for length-delimited fields: the payload). */
  tagStart: number;
  start: number;
  end: number;
}

function* fields(b: Uint8Array, from = 0, to = b.length): Generator<Field> {
  let pos = from;
  while (pos < to) {
    const tagStart = pos;
    const [tag, p] = readVarint(b, pos);
    const no = Math.floor(tag / 8);
    const wire = tag & 7;
    pos = p;
    if (wire === 0) {
      const [, q] = readVarint(b, pos);
      yield { no, wire, tagStart, start: pos, end: q };
      pos = q;
    } else if (wire === 1) {
      yield { no, wire, tagStart, start: pos, end: pos + 8 };
      pos += 8;
    } else if (wire === 5) {
      yield { no, wire, tagStart, start: pos, end: pos + 4 };
      pos += 4;
    } else if (wire === 2) {
      const [len, q] = readVarint(b, pos);
      yield { no, wire, tagStart, start: q, end: q + len };
      pos = q + len;
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire}`);
    }
  }
}

const utf8 = new TextDecoder();

function lengthDelimited(no: number, payload: number[] | Uint8Array): number[] {
  return [...varint(no * 8 + 2), ...varint(payload.length), ...payload];
}

/** Name of the output of the first node with this op type, or null. */
export function findNodeOutput(model: Uint8Array, opType: string): string | null {
  for (const f of fields(model)) {
    if (f.no !== 7 || f.wire !== 2) continue;
    for (const g of fields(model, f.start, f.end)) {
      if (g.no !== 1 || g.wire !== 2) continue;
      let op = '';
      let output: string | null = null;
      for (const n of fields(model, g.start, g.end)) {
        if (n.no === 4 && n.wire === 2) op = utf8.decode(model.subarray(n.start, n.end));
        else if (n.no === 2 && n.wire === 2 && output === null) output = utf8.decode(model.subarray(n.start, n.end));
      }
      if (op === opType) return output;
    }
  }
  return null;
}

/** Names of the graph outputs. */
export function graphOutputNames(model: Uint8Array): string[] {
  const names: string[] = [];
  for (const f of fields(model)) {
    if (f.no !== 7 || f.wire !== 2) continue;
    for (const g of fields(model, f.start, f.end)) {
      if (g.no !== 12 || g.wire !== 2) continue;
      for (const v of fields(model, g.start, g.end)) if (v.no === 1 && v.wire === 2) names.push(utf8.decode(model.subarray(v.start, v.end)));
    }
  }
  return names;
}

/** A copy of the model with `name` (a float tensor) added to the graph outputs. */
export function addGraphOutput(model: Uint8Array, name: string): Uint8Array {
  for (const f of fields(model)) {
    if (f.no !== 7 || f.wire !== 2) continue;
    // ValueInfoProto { name = 1; type = 2: TypeProto { tensor_type = 1: { elem_type = 1: FLOAT } } }
    const tensorType = [...varint(1 * 8 + 0), 1];
    const typeProto = lengthDelimited(1, tensorType);
    const valueInfo = [...lengthDelimited(1, new TextEncoder().encode(name)), ...lengthDelimited(2, typeProto)];
    const extra = lengthDelimited(12, valueInfo);
    const graphLen = f.end - f.start + extra.length;
    const head = varint(7 * 8 + 2).concat(varint(graphLen));
    const out = new Uint8Array(f.tagStart + head.length + graphLen + (model.length - f.end));
    out.set(model.subarray(0, f.tagStart), 0);
    let p = f.tagStart;
    out.set(head, p);
    p += head.length;
    out.set(model.subarray(f.start, f.end), p);
    p += f.end - f.start;
    out.set(extra, p);
    p += extra.length;
    out.set(model.subarray(f.end), p);
    return out;
  }
  throw new Error('No graph in the model');
}
