'use strict';

const HEADER = 0x20;
class Heap {
  constructor(buf, opts = {}) {
    this.buf = buf;
    this.pos = HEADER;
    this.W = opts.wordSize || (buf.length >= 0x30 && buf.readUInt32LE(0x28) === 0 && buf.readUInt32LE(0x2c) > 0 ? 8 : 4);
    this.objs = [];
    this.hot = new Array(8).fill(null);
    this.hotIdx = 0;
    this.sourceLen = buf.readUInt32LE(8);
    this.payloadLen = buf.readUInt32LE(20);
  }
  u8() { return this.buf[this.pos++]; }
  varint() {
    const b0 = this.buf[this.pos++];
    const n = (b0 & 3) + 1;
    let v = b0;
    for (let i = 1; i < n; i++) v += this.buf[this.pos++] * 2 ** (8 * i);
    return Math.floor(v / 4);
  }
  addHot(e) { this.hot[this.hotIdx] = e; this.hotIdx = (this.hotIdx + 1) & 7; return e; }

  parse() {
    const first = this.u8();
    const root = this.readObject(first);
    if (this.buf[this.pos] !== 0x0b) throw new Error('snapshot did not end on Synchronize @0x' + this.pos.toString(16));
    return root;
  }
  readObject(space) {
    const size = this.varint();
    const o = { id: this.objs.length, space, size, words: new Array(size), start: this.pos - 1 };
    this.objs.push(o);
    let i = 0;
    while (i < size) i += this.item(o, i);
    return o;
  }
  put(o, i, w) { o.words[i] = w; }
  item(o, i, indirect) {
    const at = this.pos;
    const tag = this.u8();
    if (tag <= 0x03) { const c = this.readObject(tag); this.put(o, i, { t: 'obj', id: c.id }); return 1; }
    switch (tag) {
      case 0x04: { const id = this.varint(); const e = { t: 'obj', id }; this.addHot(e); this.put(o, i, e); return 1; }
      case 0x05: { const chunk = this.varint(), off = this.varint(); this.put(o, i, { t: 'ro', chunk, off }); return 1; }
      case 0x06: { const idx = this.varint(); this.put(o, i, { t: 'sc', idx }); return 1; }
      case 0x07: { const idx = this.varint(); const e = { t: 'root', idx }; this.addHot(e); this.put(o, i, e); return 1; }
      case 0x08: { const idx = this.varint(); this.put(o, i, { t: 'att', idx }); return 1; }
      case 0x0c: { const n = this.varint() + 18; const b = this.u8(); for (let k = 0; k < n; k++) this.put(o, i + k, { t: 'root', idx: b & 0x1f }); return n; }
      case 0x11: { const n = this.varint(); this.raw(o, i, n); return n; }
      case 0x18: case 0x1d: case 0x1f: case 0x21: return this.item(o, i, tag);
      case 0x1e: this.put(o, i, { t: 'self' }); return 1;
    }
    if (tag >= 0x40 && tag <= 0x5f) { this.put(o, i, { t: 'root', idx: tag - 0x40 }); return 1; }
    if (tag >= 0x60 && tag <= 0x7f) { const n = tag - 0x5f; this.raw(o, i, n); return n; }
    if (tag >= 0x80 && tag <= 0x8f) { const n = tag - 0x80 + 2; const b = this.u8(); for (let k = 0; k < n; k++) this.put(o, i + k, { t: 'root', idx: b & 0x1f }); return n; }
    if (tag >= 0x90 && tag <= 0x97) { this.put(o, i, this.hot[tag & 7]); return 1; }
    throw new Error('unknown snapshot tag 0x' + tag.toString(16) + ' @0x' + at.toString(16));
  }
  raw(o, i, n) {
    if (this.W === 8) {
      for (let k = 0; k < n; k++) {
        const lo = this.buf.readUInt32LE(this.pos), hi = this.buf.readInt32LE(this.pos + 4);
        this.pos += 8;
        o.words[i + k] = { t: 'raw', v: lo === 0 ? (hi << 1) : lo, lo, hi, w8: true };
      }
      return;
    }
    for (let k = 0; k < n; k++) { o.words[i + k] = { t: 'raw', v: this.buf.readUInt32LE(this.pos) }; this.pos += 4; }
  }
}

const mapOf = (h, o) => { const w = o.words[0]; return w.t === 'root' ? w.idx : w.t === 'obj' ? ('obj' + w.id) : '?'; };
const rawBytes = (o, from, to) => {
  const w8 = o.words[from] && o.words[from].w8;
  const stride = w8 ? 8 : 4;
  const out = Buffer.alloc((to - from) * stride);
  for (let k = from; k < to; k++) {
    const w = o.words[k];
    if (w && w.t === 'raw') {
      if (w8) { out.writeUInt32LE(w.lo >>> 0, (k - from) * 8); out.writeInt32LE(w.hi | 0, (k - from) * 8 + 4); }
      else out.writeUInt32LE(w.v >>> 0, (k - from) * 4);
    }
  }
  return out;
};

module.exports = { Heap, mapOf, rawBytes, HEADER };
