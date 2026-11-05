'use strict';
const { disasm, jumpTarget, OPS } = require('./disasm');
const { E, ID } = require('./ast');

const READS_ACC = new Set(['kReadAccumulator', 'kReadWriteAccumulator', 'kReadAndClobberAccumulator', 'kReadAccumulatorWriteShortStar']);
const BIN = { Add: '+', Sub: '-', Mul: '*', Div: '/', Mod: '%', Exp: '**', BitwiseOr: '|', BitwiseXor: '^', BitwiseAnd: '&', ShiftLeft: '<<', ShiftRight: '>>', ShiftRightLogical: '>>>' };
const TEST = { TestEqual: '==', TestEqualStrict: '===', TestReferenceEqual: '===', TestLessThan: '<', TestGreaterThan: '>', TestLessThanOrEqual: '<=', TestGreaterThanOrEqual: '>=', TestInstanceOf: 'instanceof', TestIn: 'in' };
const TYPEOF = ['number', 'string', 'symbol', 'boolean', 'bigint', 'undefined', 'function', 'object', 'other'];

const jkind = (n) => {
  n = n.replace(/Constant$/, '');
  if (n === 'JumpIfTrue' || n === 'JumpIfToBooleanTrue') return 'T';
  if (n === 'JumpIfFalse' || n === 'JumpIfToBooleanFalse') return 'F';
  const m = { JumpIfNull: 'null', JumpIfNotNull: 'nnull', JumpIfUndefined: 'undef', JumpIfNotUndefined: 'nundef', JumpIfUndefinedOrNull: 'nullish', JumpIfJSReceiver: 'recv', JumpIfForInDone: 'forin' };
  return m[n] || null;
};
const isStar = (n) => n === 'Star' || /^Star\d+$/.test(n);

function neg(e) {
  if (e.k === 'un' && e.op === '!') return e.e;
  if (e.k === 'bin') {
    const flip = { '===': '!==', '!==': '===', '==': '!=', '!=': '==' };
    if (flip[e.op]) return E.bin(flip[e.op], e.l, e.r);
  }
  return E.un('!', e);
}
function hasEffect(e) {
  if (!e || typeof e !== 'object') return false;
  switch (e.k) {
    case 'call': case 'new': case 'assign': case 'await': case 'yield': return true;
    case 'lit': case 'id': case 'undef': case 'hole': case 'raw': case 'regexp': case 'fn': case 'classdesc': return false;
    case 'member': return hasEffect(e.obj);
    case 'index': return hasEffect(e.obj) || hasEffect(e.key);
    case 'bin': case 'logic': return hasEffect(e.l) || hasEffect(e.r);
    case 'un': case 'tostr': case 'spread': return hasEffect(e.e);
    case 'cond': return hasEffect(e.c) || hasEffect(e.a) || hasEffect(e.b);
    case 'arr': return e.elems.some(hasEffect);
    case 'obj': return e.props.some(p => hasEffect(p.value) || (p.computed && hasEffect(p.key)));
    default: return true;
  }
}

class Stop extends Error {}

class FnDec {
  constructor(prog, sfi, chain, cfg) {
    this.prog = prog; this.sfi = sfi; this.bc = sfi.bc; this.cfg = cfg;
    this.insns = disasm(this.bc.bytes);
    this.at = new Map(this.insns.map((x, i) => [x.off, i]));
    this.handlers = prog.handlerTable(this.bc);
    this.srcTab = prog.srcPosTable(this.bc);
    this.curPos = null;
    this.chain0 = chain;
    this.nv = 0;
    this.warn = [];
    this.paramNames = this.makeParamNames();
    this.vars = new Map();
    this.tempDefs = new Map();
    this.declared = [];
  }
  srcPosAt(off) {
    let p = null;
    for (const e of this.srcTab) {
      if (e.off <= off) p = e.pos; else break;
    }
    return p;
  }
  makeParamNames() {
    const n = Math.max(0, this.bc.params - 1);
    if (this.cfg.moduleWrapper && n === 5) return ['exports', 'require', 'module', '__filename', '__dirname'];
    return Array.from({ length: n }, (_, i) => 'a' + i);
  }
  newVar(prefix = 'v') { return '$' + prefix + (this.nv++); }
  poolv(i) { return this.prog.poolVal(this.bc, i); }
  jt(ins) {
    const b = ins.off + (ins.scale > 1 ? 1 : 0);
    if (ins.name === 'JumpLoop') return b - ins.ops[0];
    if (!/^Jump/.test(ins.name)) return null;
    if (/Constant$/.test(ins.name)) { const v = this.poolv(ins.ops[0]); return v.kind === 'smi' ? b + v.value : null; }
    return b + ins.ops[0];
  }
  isJumpIns(ins) { return /^Jump/.test(ins.name) && ins.name !== 'JumpLoop'; }
  isUncond(ins) { return ins.name === 'Jump' || ins.name === 'JumpConstant'; }
  isCond(ins) { return this.isJumpIns(ins) && !this.isUncond(ins); }

  accLive(off, depth = 0) {
    let i = this.at.get(off);
    while (i !== undefined && i < this.insns.length && depth < 50) {
      const ins = this.insns[i];
      const use = ins.use || OPS[ins.code].use;
      if (READS_ACC.has(use)) return true;
      if (use === 'kWriteAccumulator' || use === 'kClobberAccumulator') return false;
      if (this.isUncond(ins)) { const t = this.jt(ins); if (t == null) return true; i = this.at.get(t); depth++; continue; }
      i++;
    }
    return false;
  }

  initState() {
    return { acc: null, regs: new Map(), chain: this.chain0, ctxRegs: new Map(), pend: null };
  }
  clone(st) { return { acc: st.acc, regs: new Map(st.regs), chain: st.chain, ctxRegs: new Map(st.ctxRegs), pend: st.pend }; }

  regExpr(st, op) {
    if (op <= -7) {
      const r = -7 - op;
      if (st.regs.has(r)) return st.regs.get(r);
      return E.undef();
    }
    if (op >= 3) return E.id(this.paramNames[op - 3] || 'a' + (op - 3));
    if (op === 2) return E.id('this');
    if (op === -1) return E.raw('/*context*/');
    return E.raw('/*reg' + op + '*/');
  }
  setReg(st, op, e, out) {
    const r = -7 - op;
    if (op >= 3) { out.push({ t: 'expr', e: E.assign(E.id(this.paramNames[op - 3] || 'a' + (op - 3)), e) }); return; }
    if (op > -7) { return; }
    if (this.vars.has(r)) {
      out.push({ t: 'expr', e: E.assign(E.id(this.vars.get(r)), e) });
      st.regs.set(r, E.id(this.vars.get(r)));
      return;
    }
    if (e.k === 'fn' && e.info.name && /^(Normal|Async|Gen|AsyncGen)$/.test(e.info.kind)) {
      out.push({ t: 'fndecl', info: e.info });
      const id = E.id(e.info.name);
      st.regs.set(r, id);
      return;
    }
    const lazyId = e.k === 'id' && e.name && (e.name[0] === '$' || e.name === 'this' || this.paramNames.includes(e.name));
    if (e.k === 'lit' || e.k === 'undef' || e.k === 'raw' || e.k === 'hole' || lazyId || e.k === 'obj' || e.k === 'arr' || e.k === 'classdesc') { st.regs.set(r, e); return; }
    const n = this.newVar();
    out.push({ t: 'var', kind: 'const', name: n, e });
    this.tempDefs.set(n, e);
    st.regs.set(r, E.id(n));
  }
  readReg(st, op, out) {
    const e = this.regExpr(st, op);
    if ((e.k === 'obj' || e.k === 'arr') && op <= -7) {
      const n = this.newVar();
      out.push({ t: 'var', kind: 'const', name: n, e });
      this.tempDefs.set(n, e);
      const id = E.id(n);
      st.regs.set(-7 - op, id);
      return id;
    }
    return e;
  }
  take(st) { const a = st.acc; if (!a) return E.undef(); a.used = true; return a.e; }
  put(st, e, out) { this.flush(st, out); st.acc = { e, used: false }; }
  flush(st, out) {
    const a = st.acc;
    if (a && !a.used && hasEffect(a.e)) out.push({ t: 'expr', e: a.e });
    st.acc = null;
  }

  ctxVar(st, regOp, slot, depth) {
    let chain = st.chain;
    if (regOp !== undefined && regOp !== -1 && st.ctxRegs.has(-7 - regOp)) chain = st.ctxRegs.get(-7 - regOp);
    const sc = chain[depth];
    if (!sc) return E.raw('/*ctx' + depth + '.' + slot + '*/');
    const nm = sc.names[slot - 2 - sc.extSlot];
    return E.id(nm || ('ctx' + depth + '_' + slot));
  }

  run() {
    this.skipInit();
    const st = this.initState();
    const body = [];
    this.walk(0, this.bc.length, st, body, null);
    if (st.acc) this.flush(st, body);
    const last = body[body.length - 1];
    if (last && last.t === 'return' && (!last.e || last.e.k === 'undef')) body.pop();
    if (process.env.JSC_DEBUG) console.error('fn', this.sfi.name, this.sfi.kind, body.map(s => s.t + (s.t === 'try' ? '[' + (s.catchBody || []).map(c => c.t + (c.e ? ':' + c.e.k + (c.e.reject ? ':R' : '') : '')).join(',') + ']' : '')).join(' '));
    if (/Async/.test(this.sfi.kind)) {
      const isWrap = (s) => s.t === 'try' && s.catchBody && s.catchBody.length && (() => { const l = s.catchBody[s.catchBody.length - 1]; return l.t === 'return' && l.e && l.e.reject; })();
      for (let ix; (ix = body.findIndex(isWrap)) >= 0;) body.splice(ix, 1, ...body[ix].body);
    }
    const k = this.sfi.kind;
    const info = {
      name: this.sfi.name, params: this.paramNames, body,
      arrow: k === 'Arrow' || k === 'AsyncArrow', async: /Async/.test(k), generator: /Gen/.test(k),
      method: /Method|Getter|Setter/.test(k), kind: k,
      start: this.sfi.scope ? this.sfi.scope.start : null,
      end: this.sfi.scope ? this.sfi.scope.end : null,
    };
    return info;
  }

  walk(off, end, st, out, loop, ifctx) {
    let i = this.at.get(off);
    while (i < this.insns.length && this.insns[i].off < end) {
      const ins = this.insns[i];
      this.curPos = this.srcPosAt(ins.off);
      const prevLen = out.length;
      const hr = this.tryRange(ins.off, end);
      if (hr) { i = this.doTry(hr, i, end, st, out, loop); for (let q = prevLen; q < out.length; q++) if (out[q].pos === undefined) out[q].pos = this.curPos; continue; }
      const lp = this.loopAt(ins.off, end, loop);
      if (lp) { i = this.doLoop(lp, i, st, out, loop); for (let q = prevLen; q < out.length; q++) if (out[q].pos === undefined) out[q].pos = this.curPos; continue; }
      let nx;
      try { nx = this.step(ins, i, end, st, out, loop, ifctx); }
      catch (e) { if (!e.annot) { e.message += ` [fn "${this.sfi.name}" sfi#${this.sfi.id} @${ins.off} ${ins.name} ${ins.ops.join(',')}]`; e.annot = 1; } throw e; }
      for (let q = prevLen; q < out.length; q++) if (out[q].pos === undefined) out[q].pos = this.curPos;
      if (nx === 'stop') return 'stop';
      i = nx;
    }
    return 'end';
  }
}

module.exports = { FnDec, neg, hasEffect, BIN, TEST, TYPEOF, jkind, isStar, Stop };
require('./decompile-ops');
