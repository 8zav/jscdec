'use strict';
const { Heap, mapOf, rawBytes } = require('./heap');

const MAP = { SFI: 20, SCOPE_INFO: 19, BYTECODE: 45, TRUSTED_FIXED: 92, TRUSTED_BYTES: 94, ONE_BYTE_STR: 18, TWO_BYTE_STR: 108, TWO_BYTE_STR_W8: 112, HEAP_NUMBER: 25, FIXED: 12, FIXED2: 13 };
const smi = (w) => (w && w.t === 'raw') ? (w.v | 0) >> 1 : null;

function load(buf) {
  const h = new Heap(buf);
  h.parse();
  return h;
}

function strOf(h, o, refs) {
  const m = mapOf(h, o);
  const sfiMap = h.objs[0] ? mapOf(h, h.objs[0]) : 20;
  const isOneByte = m === sfiMap - 2 || m === sfiMap - 3;
  if (isOneByte || m === MAP.TWO_BYTE_STR || m === MAP.TWO_BYTE_STR_W8) {
    const len = h.W === 8 ? o.words[1].hi : o.words[2].v;
    const bytes = rawBytes(o, h.W === 8 ? 2 : 3, o.size);
    return isOneByte ? bytes.subarray(0, len).toString('latin1') : bytes.subarray(0, len * 2).toString('utf16le');
  }
  return null;
}

function readBytecodeArray(h, o) {
  if (h.W === 8) {
    const length = o.words[1].hi;
    const bytes = rawBytes(o, 8, o.size).subarray(0, length);
    return {
      obj: o,
      length,
      bytes,
      srcpos: o.words[3].t === 'obj' ? h.objs[o.words[3].id] : null,
      handlers: o.words[4].t === 'obj' ? h.objs[o.words[4].id] : null,
      pool: o.words[5].t === 'obj' ? h.objs[o.words[5].id] : null,
      frameSize: o.words[6].lo,
      params: o.words[6].hi & 0xffff,
      maxArgs: o.words[6].hi >>> 16,
    };
  }
  const length = smi(o.words[2]);
  const bytes = rawBytes(o, 10, o.size).subarray(0, length);
  return {
    obj: o,
    length,
    bytes,
    srcpos: o.words[4].t === 'obj' ? h.objs[o.words[4].id] : null,
    handlers: o.words[5].t === 'obj' ? h.objs[o.words[5].id] : null,
    pool: o.words[6].t === 'obj' ? h.objs[o.words[6].id] : null,
    frameSize: o.words[7].v,
    params: o.words[8].v & 0xffff,
    maxArgs: o.words[8].v >>> 16,
  };
}

function functions(h) {
  const list = [];
  for (const o of h.objs) {
    if (mapOf(h, o) !== MAP.SFI) continue;
    const d = o.words[1];
    if (!d || d.t !== 'obj') continue;
    const bo = h.objs[d.id];
    if (mapOf(h, bo) !== MAP.BYTECODE) continue;
    list.push({ sfi: o, bc: readBytecodeArray(h, bo) });
  }
  return list;
}

module.exports = { load, functions, strOf, smi, MAP };
