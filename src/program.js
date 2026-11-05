'use strict';
const fs = require('fs');
const path = require('path');
const { load, strOf, MAP } = require('./model');
const { mapOf, rawBytes } = require('./heap');
const oracle = require('./oracle');

const KINDS = ['Normal', 'Module', 'ModuleTLA', 'BaseCtor', 'DefaultBaseCtor', 'DefaultDerivedCtor', 'DerivedCtor', 'Getter', 'StaticGetter', 'Setter', 'StaticSetter',
  'Arrow', 'AsyncArrow', 'Async', 'AsyncMethod', 'StaticAsyncMethod', 'AsyncGenMethod', 'StaticAsyncGenMethod', 'AsyncGen', 'Gen', 'GenMethod', 'StaticGenMethod',
  'Method', 'StaticMethod', 'ClassMembersInit', 'ClassStaticInit', 'Invalid'];
const SCOPE_TYPES = ['class', 'eval', 'function', 'module', 'script', 'catch', 'block', 'with'];
const MODES = { 0: 'let', 1: 'const', 2: 'using', 3: 'using', 4: 'var' };
const smiv = (w) => w && w.w8 ? (w.lo === 0 ? w.hi : ((w.lo | 0) >> 1)) : ((w.v | 0) >> 1);

const W8_REFS = new Map(Object.entries({
  'root:3': { type: 'uninitialized_value' }, 'root:4': { type: 'undefined' }, 'root:5': { type: 'null' },
  'root:6': { type: 'hole' }, 'root:7': { type: 'true' }, 'root:8': { type: 'false' },
  'root:9': { type: 'string', value: '' }, 'root:171': { type: 'string', value: 'prototype' },
  'root:172': { type: 'string', value: 'name' }, 'root:175': { type: 'string', value: 'value' },
  'root:414': { type: 'string', value: '_' }, 'root:420': { type: 'string', value: 'e' },
  'root:594': { type: 'string', value: 'BigInt' }, 'root:620': { type: 'string', value: 'current' },
  'root:639': { type: 'string', value: 'done' }, 'root:652': { type: 'string', value: 'Error' },
  'root:705': { type: 'string', value: 'input' }, 'root:738': { type: 'string', value: 'message' },
  'root:767': { type: 'string', value: 'Number' }, 'root:804': { type: 'string', value: 'return' },
  'root:858': { type: 'string', value: 'total' }, 'root:1007': { type: 'string', value: 'length' },
  'root:1008': { type: 'string', value: 'next' },
  'ro:0:42800': { type: 'string', value: 'join' }, 'ro:0:54704': { type: 'string', value: 'fill' },
  'ro:0:54896': { type: 'string', value: 'push' }, 'ro:0:54992': { type: 'string', value: 'slice' },
  'ro:0:55064': { type: 'string', value: 'includes' }, 'ro:0:55512': { type: 'string', value: 'isFinite' },
  'ro:0:56192': { type: 'string', value: 'fixed' }, 'ro:0:56920': { type: 'string', value: 'toLowerCase' },
  'ro:0:61184': { type: 'string', value: 'Math' }, 'ro:0:61208': { type: 'string', value: 'abs' },
  'ro:0:61616': { type: 'string', value: 'log' }, 'ro:0:61736': { type: 'string', value: 'min' },
}));

const W4_REFS = new Map(Object.entries(require('../templates/ro-v12.8.json')));

class Program {
  constructor(buf, opts) {
    this.heap = load(buf);
    this.h = this.heap;
    this.opts = opts;
    this.refs = new Map();
    this._resolveRefs();
    this._scopes = new Map();
    this._sfis = new Map();
  }

  _resolveRefs() {
    if (this.h.W === 8) { this.refs = new Map(W8_REFS); return; }
    this.refs = new Map(W4_REFS);
    const want = [];
    for (const o of this.h.objs) {
      for (let i = 1; i < o.words.length; i++) {
        const w = o.words[i];
        if (!w) continue;
        if (w.t === 'ro' && !this.refs.has(`ro:${w.chunk}:${w.off}`)) want.push({ k: 'ro', a: w.chunk, b: w.off });
        else if (w.t === 'root' && !this.refs.has(`root:${w.idx}`)) want.push({ k: 'root', a: w.idx });
      }
    }
    if (want.length && this.opts.exe && fs.existsSync(this.opts.exe)) {
      for (const [k, v] of oracle.resolve(this.opts.exe, this.opts.template, want)) this.refs.set(k, v);
    }
  }

  val(w) {
    if (!w) return { kind: 'none' };
    switch (w.t) {
      case 'raw': return { kind: 'smi', value: smiv(w) };
      case 'ro': case 'root': {
        const r = this.refs.get(w.t === 'ro' ? `ro:${w.chunk}:${w.off}` : `root:${w.idx}`) || { type: 'unknown' };
        if (r.type === 'string') return { kind: 'str', value: r.value };
        if (r.type === 'undefined') return { kind: 'undef' };
        if (r.type === 'null') return { kind: 'null' };
        if (r.type === 'true') return { kind: 'true' };
        if (r.type === 'false') return { kind: 'false' };
        if (r.type === 'hole') return { kind: 'hole' };
        if (r.type === 'uninitialized_value') return { kind: 'uninit' };
        return { kind: 'other', type: r.type, dbg: r.dbg };
      }
      case 'obj': return this.objVal(this.h.objs[w.id]);
      case 'att': return { kind: 'attached', idx: w.idx };
      default: return { kind: 'other', type: w.t };
    }
  }
  objVal(o) {
    const m = mapOf(this.h, o);
    const s = strOf(this.h, o);
    if (s !== null) return { kind: 'str', value: s };
    switch (m) {
      case MAP.SFI: return { kind: 'sfi', obj: o };
      case MAP.SCOPE_INFO: return { kind: 'scope', obj: o };
      case 25: { const b = rawBytes(o, 1, this.h.W === 8 ? 2 : 3); return { kind: 'num', value: b.readDoubleLE(0) }; }
      case 43: { const b = rawBytes(o, 2, o.size); return { kind: 'bigint', value: '0x' + b.readBigUInt64LE(0).toString(16).toUpperCase() + 'n' }; }
      case 44: return { kind: 'objdesc', obj: o };
      case 678: case 696: case 938: return { kind: 'arrdesc', obj: o };
      case 685: case 703: case 945: return { kind: 'classdesc', obj: o };
      default: return { kind: 'other', type: 'map' + m, obj: o };
    }
  }
  str(w) { const v = this.val(w); return v.kind === 'str' ? v.value : null; }

  scope(o) {
    if (this._scopes.has(o.id)) return this._scopes.get(o.id);
    const f = smiv(o.words[1]);
    const type = f & 15;
    const info = {
      id: o.id,
      flags: f,
      type: SCOPE_TYPES[type],
      kind: KINDS[(f >> 16) & 31],
      hasOuter: !!((f >> 21) & 1),
      extSlot: (f >> 25) & 1,
      paramCount: smiv(o.words[2]),
      names: [], modes: [], paramIdx: [],
      start: null, end: null, fnName: null, outer: null,
    };
    const n = smiv(o.words[3]);
    let p = 4;
    if (type !== 5 && type !== 6 && type !== 7) { info.start = smiv(o.words[p]); info.end = smiv(o.words[p + 1]); p += 2; }
    for (let i = 0; i < n; i++) info.names.push(this.str(o.words[p + i]));
    p += n;
    for (let i = 0; i < n; i++) {
      const v = smiv(o.words[p + i]);
      info.modes.push(MODES[v & 15] || 'let');
      const pn = (v >> 6) & 0xffff;
      info.paramIdx.push(null);
    }
    p += n;
    const rest = o.words.slice(p);
    for (const w of rest) {
      const v = this.val(w);
      if (v.kind === 'scope') info.outer = v.obj;
    }
    if (rest.length >= 2) { const nm = this.val(rest[0]); if (nm.kind === 'str' && nm.value) info.fnName = nm.value; }
    if (!info.fnName && rest.length >= 3) { const nm = this.val(rest[2]); if (nm.kind === 'str' && nm.value) info.fnName = nm.value; }
    this._scopes.set(o.id, info);
    return info;
  }

  sfi(o) {
    if (this._sfis.has(o.id)) return this._sfis.get(o.id);
    const d = o.words[1];
    const bo = d && d.t === 'obj' ? this.h.objs[d.id] : null;
    let bc = null;
    if (bo && mapOf(this.h, bo) === MAP.BYTECODE) {
      if (this.h.W === 8) {
        const length = bo.words[1].hi;
        const bytes = rawBytes(bo, 8, bo.size).subarray(0, length);
        bytes.w8 = true;
        bc = {
          length,
          bytes,
          pool: bo.words[5].t === 'obj' ? this.h.objs[bo.words[5].id] : null,
          handlers: bo.words[4].t === 'obj' ? this.h.objs[bo.words[4].id] : null,
          srcpos: bo.words[3].t === 'obj' ? this.h.objs[bo.words[3].id] : null,
          frameSize: bo.words[6].lo,
          params: bo.words[6].hi & 0xffff,
        };
      } else {
        const length = smiv(bo.words[2]);
        bc = {
          length,
          bytes: rawBytes(bo, 10, bo.size).subarray(0, length),
          pool: bo.words[6].t === 'obj' ? this.h.objs[bo.words[6].id] : null,
          handlers: bo.words[5].t === 'obj' ? this.h.objs[bo.words[5].id] : null,
          srcpos: bo.words[4].t === 'obj' ? this.h.objs[bo.words[4].id] : null,
          frameSize: bo.words[7].v,
          params: bo.words[8].v & 0xffff,
        };
      }
    }
    const w3 = this.val(o.words[3]);
    let scope = null, name = null;
    if (w3.kind === 'scope') scope = this.scope(w3.obj);
    else if (w3.kind === 'str') name = w3.value;
    const info = { id: o.id, obj: o, bc, scope, name: name || (scope && scope.fnName) || '', kind: scope ? scope.kind : 'Normal' };
    this._sfis.set(o.id, info);
    return info;
  }
  handlerTable(bc) {
    if (!bc.handlers) return [];
    const o = bc.handlers;
    if (mapOf(this.h, o) !== MAP.TRUSTED_BYTES && mapOf(this.h, o) !== 97) return [];
    const len = smiv(o.words[1]);
    const b = rawBytes(o, 2, o.size).subarray(0, len);
    const out = [];
    for (let i = 0; i + 16 <= b.length; i += 16) {
      out.push({ start: b.readInt32LE(i), end: b.readInt32LE(i + 4), handler: b.readInt32LE(i + 8) >> 4, pred: b.readInt32LE(i + 8) & 15, ctxReg: b.readInt32LE(i + 12) });
    }
    return out;
  }
  srcPosTable(bc) {
    if (!bc || !bc.srcpos) return [];
    const o = bc.srcpos;
    if (mapOf(this.h, o) !== MAP.TRUSTED_BYTES && mapOf(this.h, o) !== 97) return [];
    const len = smiv(o.words[1]);
    const b = rawBytes(o, 2, o.size).subarray(0, len);
    let i = 0, bcOff = -1, srcPos = 0;
    const readVar = () => {
      let r = 0, s = 0;
      while (i < b.length) {
        const x = b[i++];
        r |= (x & 0x3f) << s;
        s += 6;
        if (!(x & 0x80)) return (x & 0x40) ? -r : r;
      }
      return r;
    };
    const out = [];
    while (i < b.length) {
      const d = readVar();
      const p = readVar();
      bcOff += (d >= 0 ? d : -d - 1);
      srcPos += p >> 1;
      out.push({ off: bcOff, pos: srcPos, stmt: d < 0 });
    }
    return out;
  }
  poolVal(bc, idx) {
    const w = bc.pool && bc.pool.words[2 + idx];
    return this.val(w);
  }
  topSfi() { return this.h.objs[0]; }
}

module.exports = { Program, KINDS };
