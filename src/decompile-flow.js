'use strict';
const { FnDec, neg, hasEffect, jkind } = require('./decompile');
const { E } = require('./ast');
const P = FnDec.prototype;

const sameExpr = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const terminal = (arr) => { const l = arr[arr.length - 1]; return !!l && (l.t === 'return' || l.t === 'throw' || l.t === 'break' || l.t === 'continue'); };

P.idxAt = function (off) { const i = this.at.get(off); return i === undefined ? this.insns.length : i; };
P.constCond = function (e) {
  if (e.k === 'lit') return !!e.v;
  if (e.k === 'bin' && e.l.k === 'lit' && e.r.k === 'lit') {
    const a = e.l.v, b = e.r.v;
    switch (e.op) { case '===': return a === b; case '!==': return a !== b; case '==': return a == b; case '!=': return a != b; }
  }
  return undefined;
};
P.skipInit = function () {
  this.skipRegs = new Set();
  this.loopHeads = new Map();
  for (const ins of this.insns) {
    if (ins.name === 'ForInNext') { this.skipRegs.add(-7 - ins.ops[1]); this.skipRegs.add(-7 - ins.ops[2]); this.skipRegs.add(-7 - ins.ops[2] + 1); }
    if (ins.name === 'JumpLoop') {
      const t = this.jt(ins);
      const cur = this.loopHeads.get(t);
      if (!cur || cur.off < ins.off) this.loopHeads.set(t, ins);
    }
  }
};

P.loopAt = function (off, end, loop) {
  if (!this.loopHeads) this.skipInit();
  const jl = this.loopHeads.get(off);
  if (!jl) return null;
  if (loop && loop.header === off) return null;
  if (jl.off >= end + 0 && jl.off > end) return null;
  return jl;
};
P.regsWritten = function (from, to) {
  const w = new Set();
  for (const ins of this.insns) {
    if (ins.off < from || ins.off >= to) continue;
    if (/^Star(\d+)?$/.test(ins.name)) w.add(ins.name === 'Star' ? -7 - ins.ops[0] : Number(ins.name.slice(4)));
    else if (ins.name === 'Mov' && ins.ops[0] !== -1) w.add(-7 - ins.ops[1]);
  }
  return w;
};
P.firstAccessIsRead = function (r, fromOff, toOff) {
  for (const ins of this.insns) {
    if (ins.off < fromOff || ins.off >= toOff) continue;
    if (ins.name === 'SuspendGenerator' || ins.name === 'ResumeGenerator') continue;
    const ty = ins.types || [];
    for (let k = 0; k < ty.length; k++) {
      const t = ty[k];
      const reg = (t === 'kReg' || t === 'kRegInOut') && ins.ops[k] === -7 - r;
      if (reg) return true;
      if (t === 'kRegList') { for (let j = 0; j < ins.ops[k + 1]; j++) if (ins.ops[k] - j === -7 - r) return true; }
      if ((t === 'kRegPair' || t === 'kRegOutPair') && (ins.ops[k] === -7 - r || ins.ops[k] - 1 === -7 - r)) return t === 'kRegPair';
    }
    if (/^Star(\d+)?$/.test(ins.name)) { const x = ins.name === 'Star' ? -7 - ins.ops[0] : Number(ins.name.slice(4)); if (x === r) return false; }
    if (ins.name === 'Mov' && -7 - ins.ops[1] === r) return false;
  }
  return false;
};
P.commit = function (st, out) {
  this.flush(st, out);
  for (const [r, e] of [...st.regs]) {
    if (e && (e.k === 'obj' || e.k === 'arr') && !e.props?.some(p => p.kind === 'pending')) {
      const n = this.newVar();
      out.push({ t: 'var', kind: 'const', name: n, e });
      this.tempDefs.set(n, e);
      st.regs.set(r, E.id(n));
    }
  }
};
P.doLoop = function (jl, i, st, out, parent) {
  this.commit(st, out);
  const header = this.insns[i].off;
  const exit = jl.off + jl.len;
  for (const r of this.regsWritten(header, jl.off)) {
    if (!st.regs.has(r) || this.vars.has(r)) continue;
    const cur = st.regs.get(r);
    if (cur.k === 'undef') continue;
    const live = this.firstAccessIsRead(r, header, jl.off) || this.firstAccessIsRead(r, exit, this.bc.length);
    if (!live) continue;
    const n = this.newVar();
    out.push({ t: 'var', kind: 'let', name: n, e: cur });
    this.vars.set(r, n);
    st.regs.set(r, E.id(n));
  }
  const stBody = this.clone(st);
  const ctx = { header, exit, cont: jl.off, parent, label: null, forinKey: null };
  const body = [];
  const hasForIn = this.insns.some(x => x.off >= header && x.off < jl.off && x.name === 'ForInNext');
  let forinObj = null;
  if (hasForIn) {
    stBody.forinKey = null;
  }
  this.walk(header, jl.off, stBody, body, ctx);
  this.flush(stBody, body);
  let stmt;
  if (hasForIn && ctx.forin) {
    stmt = { t: 'forin', decl: 'const', name: ctx.forin.key, e: ctx.forin.obj, body };
  } else {
    stmt = { t: 'while', c: E.lit(true), body };
  }
  if (ctx.label) stmt.label = ctx.label;
  out.push(stmt);
  st.acc = null;
  return this.at.get(exit);
};

P.isUpdateJump = function (t, l) {
  if (!l || l.cont < 0 || t == null || t <= l.header || t > l.cont || l.cont - t > 25) return false;
  const i0 = this.at.get(t), i1 = this.at.get(l.cont);
  if (i0 === undefined || i1 === undefined) return false;
  const slice = this.insns.slice(i0, i1);
  return slice.length <= 6 && slice.every(x => /^(LdaZero|LdaSmi|Ldar|Lda(Immutable)?(Current)?ContextSlot|Inc|Dec|AddSmi|SubSmi|Star\d*|Sta(Current)?ContextSlot|PopContext|Mov)$/.test(x.name));
};
P.doJump = function (ins, i, end, st, out, loop) {
  this.flush(st, out);
  const t = this.jt(ins);
  if (st.token && (t === st.token.fin.fb || t === st.token.fin.fb2)) {
    const { k, fin } = st.token; st.token = null;
    const ent = fin.entries.find(e => e.k === k);
    if (ent) { const s2 = this.clone(st); this.walk(ent.start, ent.end, s2, out, loop); }
    else if (k === -1 && fin.forOf) { for (let l = loop; l; l = l.parent) if (l.exit === fin.cont || l.exit2 === fin.cont) { out.push({ t: 'break', label: l === loop ? null : this.labelFor(l) }); break; } }
    else if (k !== -1) out.push({ t: 'comment', text: 'finally token ' + k });
    return i + 1;
  }
  if (ins.name === 'JumpLoop') {
    for (let l = loop; l; l = l.parent) {
      if (l.header === t) {
        if (ins.off === l.cont) return i + 1;
        out.push({ t: 'continue', label: l === this.realLoop(loop) ? null : this.labelFor(l) });
        return i + 1;
      }
    }
    return i + 1;
  }
  for (let l = loop; l; l = l.parent) {
    if (t === l.exit || t === l.exit2) { out.push({ t: 'break', label: l === loop ? null : this.labelFor(l) }); return i + 1; }
  }
  for (let l = loop; l; l = l.parent) {
    if (this.isUpdateJump(t, l)) {
      l.updateOff = t;
      out.push({ t: 'continue', label: l === this.realLoop(loop) ? null : this.labelFor(l) });
      return i + 1;
    }
  }
  if (t != null && t >= end) { out.push({ t: 'comment', text: 'jump -> ' + t }); return i + 1; }
  out.push({ t: 'comment', text: 'goto ' + t });
  return i + 1;
};
P.realLoop = function (l) { while (l && l.isSwitch) l = l.parent; return l; };
P.labelFor = function (l) { if (!l.label) l.label = 'L' + (this._lbl = (this._lbl || 0) + 1); return l.label; };

P.mergeRegs = function (st, parentOut, insertAt, sts, outs, joinOff, base) {
  const keys = new Set();
  for (const s of sts) for (const k of s.regs.keys()) keys.add(k);
  const decls = [];
  for (const r of keys) {
    const es = sts.map(s => s.regs.get(r));
    if (base && sts.length === 1) {
      const b0 = base.get(r);
      if (es[0] && b0 && sameExpr(es[0], b0)) { st.regs.set(r, es[0]); continue; }
      if (es[0] && es[0].k === 'id' && es[0].name[0] !== '$') { st.regs.set(r, es[0]); continue; }
      if (es[0] && (es[0].k === 'lit' || es[0].k === 'undef' || es[0].k === 'fn' || es[0].k === 'raw')) { st.regs.set(r, es[0]); continue; }
      if (joinOff !== undefined && !this.firstAccessIsRead(r, joinOff, this.bc.length)) { st.regs.set(r, es[0]); continue; }
      const n = this.newVar();
      decls.push(n);
      outs[0].push({ t: 'expr', e: E.assign(E.id(n), es[0]) });
      st.regs.set(r, E.id(n));
      continue;
    }
    if (es.every(e => e && sameExpr(e, es[0]))) { st.regs.set(r, es[0]); continue; }
    if (joinOff !== undefined && !this.firstAccessIsRead(r, joinOff, this.bc.length)) { st.regs.set(r, es.find(Boolean) || E.undef()); continue; }
    if (es.some(e => !e)) {
      st.regs.set(r, es.find(Boolean));
      continue;
    }
    let n = this.vars.get(r);
    if (!n) { n = this.newVar(); decls.push(n); }
    es.forEach((e, k) => { if (!(e.k === 'id' && e.name === n)) outs[k].push({ t: 'expr', e: E.assign(E.id(n), e) }); });
    st.regs.set(r, E.id(n));
  }
  if (decls.length) parentOut.splice(insertAt, 0, { t: 'decl', kind: 'let', names: decls });
};

P.jumpExpr = function (ins, st) {
  const k = jkind(ins.name);
  const a = this.take(st);
  switch (k) {
    case 'T': return a;
    case 'F': return neg(a);
    case 'null': return E.bin('===', a, E.lit(null));
    case 'nnull': return E.bin('!==', a, E.lit(null));
    case 'undef': return E.bin('===', a, E.undef());
    case 'nundef': return E.bin('!==', a, E.undef());
    case 'nullish': return E.bin('==', a, E.lit(null));
    case 'recv': return E.bin('===', E.un('typeof', a), E.lit('object'));
    default: return a;
  }
};
P.doCond = function (ins, i, end, st, out, loop, ifctx) {
  const t = this.jt(ins);
  const kind = jkind(ins.name);
  const next = ins.off + ins.len;
  if (kind === 'forin') return i + 1;
  if (t == null || t <= ins.off) { out.push({ t: 'comment', text: 'bad cond jump' }); return i + 1; }

  for (let l = loop; l; l = l.parent) {
    if (t === l.exit || t === l.exit2) {
      const J = this.jumpExpr(ins, st);
      this.commit(st, out);
      out.push({ t: 'if', c: J, a: [{ t: 'break', label: l === loop ? null : this.labelFor(l) }], b: null });
      return i + 1;
    }
  }

  if (st.acc && st.acc.forinKey && kind === 'undef') {
    const keyVar = st.acc.forinKey;
    if (loop && !loop.forin) loop.forin = { key: keyVar, obj: st.acc.forinObj };
    return i + 1;
  }
  if (st.acc && st.acc.forinKey && loop && !loop.forin) loop.forin = { key: st.acc.forinKey, obj: st.acc.forinObj };

  const Jexpr = this.jumpExpr(ins, st);
  const cont = neg(Jexpr);
  { const cf = this.constCond(cont); if (cf === true) return i + 1; if (cf === false) return this.idxAt(t); }

  if (ifctx && t === ifctx.target && out.length === ifctx.start && (kind === 'F' || kind === 'nnull' || kind === 'nundef')) {
    ifctx.cond = E.logic('&&', ifctx.cond, cont);
    return i + 1;
  }
  if (kind === 'T' && Jexpr.k === 'bin' && Jexpr.op === '===') {
    const r = this.trySwitch(ins, i, Jexpr, st, out, loop, end);
    if (r !== null) return r;
  }
  if (kind === 'F' && this.insns[i - 2]?.name === 'TestTypeOf') {
    const r = this.trySmiSwitch(ins, i, Jexpr, st, out, loop, end);
    if (r !== null) return r;
  }
  const live = this.accLive(t);

  if (live) return this.valueMerge(ins, i, t, Jexpr, cont, st, out, loop, kind);

  const lastIdx = this.idxAt(t) - 1;
  const last = this.insns[lastIdx];
  if (kind === 'nullish') {
    const nx = this.insns[i + 1];
    if (nx && this.isUncond(nx)) {
      const u = this.jt(nx);
      if (u > t && this.accLive(u)) {
        const lhsExpr = Jexpr.l;
        const sT = this.clone(st); const oT = [];
        sT.acc = null;
        this.walk(t, u, sT, oT, loop);
        if (!oT.length && sT.acc) {
          this.flush(st, out);
          st.acc = { e: E.logic('??', lhsExpr, sT.acc.e), used: false };
          return this.at.get(u);
        }
      }
    }
  }
  if (last && this.isUncond(last) && this.jt(last) > t && this.accLive(this.jt(last)) && (kind === 'F' || kind === 'T' || kind === 'nullish' || kind === 'null' || kind === 'nnull' || kind === 'undef' || kind === 'nundef')) {
    return this.ternary(ins, i, t, last, Jexpr, cont, st, out, loop);
  }

  this.commit(st, out);
  {
    const ch = this.chainCond(ins, i, Jexpr, st, loop);
    if (ch) {
      st.regs = new Map(ch.regs);
      return this.buildIf(ch.cond, ch.B, ch.E, st, out, loop, ch.resume, false, end);
    }
  }

  return this.buildIf(cont, next, t, st, out, loop, i + 1, false, end);
};
function substId(e, name, repl) {
  if (!e || typeof e !== 'object') return e;
  if (e.k === 'id' && e.name === name) return repl;
  if (e.k === 'fn') return e;
  const copy = Array.isArray(e) ? e.slice() : { ...e };
  for (const k of Object.keys(copy)) {
    const v = copy[k];
    if (Array.isArray(v)) copy[k] = v.map(x => substId(x, name, repl));
    else if (v && typeof v === 'object') copy[k] = substId(v, name, repl);
  }
  return copy;
}
P.chainCond = function (ins, i, J1, st, loop) {
  const chain = [{ T: this.jt(ins), J: J1, idx: i, regs: st.regs }];
  let scratch = this.clone(st); scratch.acc = null;
  let cur = i;
  while (chain.length < 8) {
    const s2 = this.clone(scratch); s2.acc = null; const tmp = [];
    let k = cur + 1, found = null;
    while (k < this.insns.length && k - cur < 40) {
      const x = this.insns[k];
      if (this.loopHeads && this.loopHeads.has(x.off)) break;
      if (this.handlers.some(h => h.start === x.off || h.end === x.off || h.handler === x.off)) break;
      if (this.isCond(x) && jkind(x.name) !== 'forin') { found = k; break; }
      if (this.isJumpIns(x) || /^(JumpLoop|Return|Throw|ReThrow)$/.test(x.name)) break;
      let r;
      try { r = this.step(x, k, Infinity, s2, tmp, null); } catch (e) { break; }
      if (tmp.some(s => s.t !== 'var' || !s.name || s.name[0] !== '$') || r !== k + 1) { found = null; break; }
      k++;
    }
    if (found === null || !s2.acc) break;
    const jx = this.insns[found];
    let Jn = this.jumpExpr(jx, s2);
    for (let ti = tmp.length - 1; ti >= 0; ti--) {
      const tv = tmp[ti];
      Jn = substId(Jn, tv.name, tv.e);
      for (const [rk, rv] of s2.regs) s2.regs.set(rk, substId(rv, tv.name, tv.e));
    }
    chain.push({ T: this.jt(jx), J: Jn, idx: found, regs: s2.regs });
    scratch = s2; cur = found;
  }
  if (chain.length < 2) return null;
  for (let m = chain.length; m >= 2; m--) {
    const lastIns = this.insns[chain[m - 1].idx];
    const B = lastIns.off + lastIns.len;
    const starts = chain.slice(0, m).map((_, q) => q === 0 ? ins.off : this.insns[chain[q - 1].idx].off + this.insns[chain[q - 1].idx].len);
    const Ts = chain.slice(0, m).map(c => c.T);
    const Eo = Math.max(...Ts);
    if (B >= Eo || chain[m - 1].T !== Eo) continue;
    if (!Ts.every((t, q) => t === B || t === Eo || starts.slice(q + 1).includes(t))) continue;
    const reach = new Array(m + 1);
    reach[m] = true;
    let ok = true;
    for (let q = m - 1; q >= 0; q--) {
      const Jq = chain[q].J, Tq = chain[q].T, fall = reach[q + 1];
      if (Tq === B) {
        reach[q] = fall === true ? Jq : E.logic('||', Jq, fall);
      } else if (Tq === Eo) {
        reach[q] = fall === true ? neg(Jq) : E.logic('&&', neg(Jq), fall);
      } else {
        const q2 = starts.indexOf(Tq);
        const jmp = reach[q2];
        if (fall && fall.k === 'logic' && fall.op === '||' && sameExpr(fall.r, jmp)) {
          reach[q] = E.logic('||', E.logic('&&', neg(Jq), fall.l), jmp);
        } else if (fall && fall.k === 'logic' && fall.op === '&&' && sameExpr(fall.r, jmp)) {
          reach[q] = E.logic('&&', E.logic('||', Jq, fall.l), jmp);
        } else { ok = false; break; }
      }
    }
    if (!ok || reach[0] === true || !reach[0]) continue;
    return { cond: reach[0], B, E: Eo, resume: this.idxAt(B), regs: chain[m - 1].regs };
  }
  return null;
};
P.walkUntil = function (idx, endOff, st, out, loop) { return this.walk(this.insns[idx].off, endOff, st, out, loop); };

P.buildIf = function (cond, thenStartOrIdx, t, st, out, loop, resumeIdx, merged, end) {
  let thenStart;
  if (merged) thenStart = this.insns[thenStartOrIdx] ? this.insns[thenStartOrIdx].off : t; else thenStart = thenStartOrIdx;
  const lastIdx = this.idxAt(t) - 1;
  const last = this.insns[lastIdx];
  const elseEnd = last && this.isUncond(last) ? this.jt(last) : null;
  const isFin = elseEnd !== null && this.finStack && this.finStack.some(f => f.fb === elseEnd || f.fb2 === elseEnd);
  const pastEnd = elseEnd !== null && ((end !== undefined && elseEnd > end) || (loop && loop.cont > 0 && elseEnd > loop.cont));
  const hasElse = elseEnd !== null && elseEnd > t && !this.isLoopTarget(elseEnd, loop) && !isFin && !pastEnd && lastIdx >= this.at.get(thenStart);
  const thenEnd = hasElse ? last.off : t;
  const ifctx = { target: t, start: 0, cond };
  const stT = this.clone(st); const oT = [];
  stT.acc = null;
  this.flush(st, out);
  this.walk(thenStart, thenEnd, stT, oT, loop, ifctx);
  this.flush(stT, oT);
  let stE = null, oE = [];
  const insertAt = out.length;
  if (hasElse) {
    stE = this.clone(st); stE.acc = null;
    this.walk(t, elseEnd, stE, oE, loop);
    this.flush(stE, oE);
  }
  const ifs = { t: 'if', c: ifctx.cond, a: oT, b: hasElse ? oE : null };
  out.push(ifs);
  const tt = terminal(oT);
  const sts = [], outs = [];
  if (!tt) { sts.push(stT); outs.push(oT); }
  if (hasElse) { if (!terminal(oE)) { sts.push(stE); outs.push(oE); } }
  else { sts.push(st); outs.push(null); }
  const real = outs.map(o => o || []);
  if (sts.length === 1) { st.regs = new Map(sts[0].regs); st.chain = sts[0].chain; st.ctxRegs = sts[0].ctxRegs; }
  else {
    const tmpOuts = outs.map(o => o || []);
    this.mergeRegs(st, out, insertAt, sts, tmpOuts, hasElse ? elseEnd : t);
    if (!hasElse && tmpOuts[1].length) { ifs.b = tmpOuts[1]; }
    st.chain = sts[0].chain;
  }
  st.acc = null;
  return this.idxAt(hasElse ? elseEnd : t);
};
P.trySwitch = function (ins, i, Jexpr, st, out, loop, end) {
  const prev = this.insns[i - 1];
  if (!prev || !/^(TestEqualStrict|TestReferenceEqual)$/.test(prev.name)) return null;
  const tagOp = prev.ops[0];
  const cases = [{ test: Jexpr.r, L: this.jt(ins) }];
  let j = i + 1;
  for (;;) {
    const a = this.insns[j], b = this.insns[j + 1], c = this.insns[j + 2];
    if (!(a && b && c && /^Lda/.test(a.name) && b.name === prev.name && b.ops[0] === tagOp && /^JumpIf(ToBoolean)?True(Constant)?$/.test(c.name))) break;
    const s2 = this.clone(st); s2.acc = null; const tmp = [];
    this.step(a, j, end, s2, tmp, loop);
    if (!s2.acc || tmp.length) return null;
    cases.push({ test: s2.acc.e, L: this.jt(c) });
    j += 3;
  }
  const dj = this.insns[j];
  if (!dj || !this.isUncond(dj)) return null;
  const D = this.jt(dj);
  const starts = [...new Set([...cases.map(c => c.L), D])].sort((x, y) => x - y);
  let Lend = D;
  const bodyFrom = starts[0];
  for (const x of this.insns) {
    if (x.off < bodyFrom || !this.isUncond(x)) continue;
    const t = this.jt(x);
    if (t != null && t > x.off && t >= Math.max(...starts) && t <= end) Lend = Math.max(Lend, t);
    if (x.off >= Lend) break;
  }
  if (D === Lend && !cases.some(c => c.L === D)) { /* no default */ }
  const bounds = [...starts.filter(s => s < Lend), Lend];
  const ctx = { header: -1, exit: Lend, cont: -1, parent: loop, isSwitch: true, label: null };
  const entries = [];
  const sts = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const s0 = bounds[k], e0 = bounds[k + 1];
    const stc = this.clone(st); stc.acc = null;
    const body = [];
    this.walk(s0, e0, stc, body, ctx);
    this.flush(stc, body);
    const tests = cases.filter(c => c.L === s0).map(c => c.test);
    const isDefault = s0 === D && Lend !== D;
    entries.push({ start: s0, tests, isDefault, body });
  }
  this.flush(st, out);
  const sw = { t: 'switch', d: Jexpr.l, cases: [] };
  for (const e of entries) {
    const list = [];
    if (e.isDefault) list.push({ test: null });
    e.tests.forEach(tst => list.push({ test: tst }));
    list.forEach((c, q) => sw.cases.push({ test: c.test, body: q === list.length - 1 ? e.body : [] }));
  }
  if (!sw.cases.length) return null;
  out.push(sw);
  st.acc = null;
  return this.idxAt(Lend);
};
P.trySmiSwitch = function (ins, i, Jexpr, st, out, loop, end) {
  let swIdx = -1;
  for (let k = i + 1; k < Math.min(this.insns.length, i + 20); k++) {
    if (this.insns[k].name === 'SwitchOnSmiNoFeedback') { swIdx = k; break; }
  }
  if (swIdx < 0) return null;
  const swIns = this.insns[swIdx];
  const dj = this.insns[swIdx + 1]?.name === 'Ldar' ? this.insns[swIdx + 2] : this.insns[swIdx + 1];
  if (!dj || !this.isUncond(dj)) return null;
  const D = this.jt(dj);
  const cases = [];
  for (let k = 0; k < swIns.ops[1]; k++) {
    const v = this.poolv(swIns.ops[0] + k);
    if (v.kind === 'smi') cases.push({ test: E.lit(swIns.ops[2] + k), L: swIns.off + v.value });
  }
  const starts = [...new Set([...cases.map(c => c.L), D])].sort((x, y) => x - y);
  let Lend = D;
  const dIns = this.insns[this.idxAt(D)];
  if (dIns && this.isUncond(dIns) && this.jt(dIns) > D) Lend = Math.max(Lend, this.jt(dIns));
  for (const x of this.insns) {
    if (x.off < starts[0] || !this.isUncond(x)) continue;
    const t = this.jt(x);
    if (t != null && t > x.off && t >= Math.max(...starts) && t <= end) Lend = Math.max(Lend, t);
    if (x.off >= Lend) break;
  }
  const bounds = [...starts.filter(s => s < Lend), Lend];
  const ctx = { header: -1, exit: Lend, cont: -1, parent: loop, isSwitch: true, label: null };
  const entries = [];
  for (let k = 0; k < bounds.length - 1; k++) {
    const s0 = bounds[k], e0 = bounds[k + 1];
    const stc = this.clone(st); stc.acc = null;
    const body = [];
    this.walk(s0, e0, stc, body, ctx);
    this.flush(stc, body);
    const tests = cases.filter(c => c.L === s0).map(c => c.test);
    const isDefault = s0 === D && Lend !== D;
    entries.push({ start: s0, tests, isDefault, body });
  }
  this.flush(st, out);
  const disc = Jexpr.l?.k === 'un' && Jexpr.l.op === 'typeof' ? Jexpr.l.e : Jexpr.l;
  const sw = { t: 'switch', d: disc, cases: [] };
  for (const e of entries) {
    const list = [];
    e.tests.forEach(tst => list.push({ test: tst }));
    if (e.isDefault) list.push({ test: null });
    list.forEach((c, q) => sw.cases.push({ test: c.test, body: q === list.length - 1 ? e.body : [] }));
  }
  if (!sw.cases.length) return null;
  out.push(sw);
  st.acc = null;
  return this.idxAt(Lend);
};
P.isLoopTarget = function (off, loop) {
  for (let l = loop; l; l = l.parent) if (off === l.exit || off === l.exit2 || off === l.cont || this.isUpdateJump(off, l)) return true;
  return false;
};

P.ternary = function (ins, i, t, last, Jexpr, cont, st, out, loop) {
  const u = this.jt(last);
  const stF = this.clone(st); stF.acc = null; const oF = [];
  const stJ = this.clone(st); stJ.acc = null; const oJ = [];
  this.walk(ins.off + ins.len, last.off, stF, oF, loop);
  this.walk(t, u, stJ, oJ, loop);
  this.flush(st, out);
  if (!oF.length && !oJ.length && stF.acc && stJ.acc) {
    st.acc = { e: E.cond(cont, stF.acc.e, stJ.acc.e), used: false };
  } else {
    const n = this.newVar('t');
    out.push({ t: 'decl', kind: 'let', names: [n] });
    if (stF.acc) oF.push({ t: 'expr', e: E.assign(E.id(n), stF.acc.e) });
    if (stJ.acc) oJ.push({ t: 'expr', e: E.assign(E.id(n), stJ.acc.e) });
    out.push({ t: 'if', c: cont, a: oF, b: oJ });
    st.acc = { e: E.id(n), used: false };
  }
  return this.at.get(u);
};

P.valueMerge = function (ins, i, t, Jexpr, cont, st, out, loop, kind) {
  const lhs = Jexpr.k === 'un' && Jexpr.op === '!' ? Jexpr.e : Jexpr;
  const sT = this.clone(st); const oT = [];
  sT.acc = null;
  this.walk(ins.off + ins.len, t, sT, oT, loop);
  const op = kind === 'F' ? '&&' : kind === 'T' ? '||' : kind === 'nullish' ? '??' : '&&';
  const lhsExpr = (kind === 'F' || kind === 'T') ? lhs : (Jexpr.l || lhs);
  this.flush(st, out);
  if (!oT.length && sT.acc) {
    st.acc = { e: E.logic(op, lhsExpr, sT.acc.e), used: false };
  } else {
    const n = this.newVar('t');
    out.push({ t: 'var', kind: 'let', name: n, e: lhsExpr });
    if (sT.acc) oT.push({ t: 'expr', e: E.assign(E.id(n), sT.acc.e) });
    const c = kind === 'F' ? E.id(n) : kind === 'T' ? neg(E.id(n)) : E.bin('==', E.id(n), E.lit(null));
    out.push({ t: 'if', c, a: oT, b: null });
    st.acc = { e: E.id(n), used: false };
  }
  return this.idxAt(t);
};

P.tryRange = function (off, end) {
  if (!this.doneTry) this.doneTry = new Set();
  const hs = this.handlers.filter(h => h.start === off && !this.doneTry.has(h));
  if (!hs.length) return null;
  hs.sort((a, b) => b.end - a.end);
  return hs[0];
};
const starReg = (x) => (x && x.name === 'Star' ? x.ops[0] : x && /^Star\d+$/.test(x.name) ? -7 - Number(x.name.slice(4)) : null);
P.parseFinallyPrologue = function (off) {
  const i = this.at.get(off); if (i === undefined) return null;
  const q = this.insns.slice(i, i + 6).map(x => x.name);
  const isS = (n) => n === 'Star' || /^Star\d+$/.test(n);
  if (!(isS(q[0]) && q[1] === 'LdaZero' && isS(q[2]) && q[3] === 'LdaTheHole' && q[4] === 'SetPendingMessage' && isS(q[5]))) return null;
  const nx = this.insns[i + 6];
  return { exc: starReg(this.insns[i]), tok: starReg(this.insns[i + 2]), msg: starReg(this.insns[i + 5]), fb: nx ? nx.off : this.bc.length, fb2: this.insns[i + 3].off };
};
P.parseDispatch = function (fb, tok, exc, msg) {
  let i = this.at.get(fb);
  for (let j = i; j !== undefined && j < this.insns.length - 1; j++) {
    const x = this.insns[j], y = this.insns[j + 1];
    if (x.name === 'Ldar' && x.ops[0] === tok && y.name === 'SwitchOnSmiNoFeedback') {
      const jmp = this.insns[j + 2];
      if (!jmp || !this.isUncond(jmp)) break;
      const cont = this.jt(jmp);
      const targets = [];
      for (let k = 0; k < y.ops[1]; k++) {
        const v = this.poolv(y.ops[0] + k);
        targets.push({ k: y.ops[2] + k, start: v.kind === 'smi' ? y.off + v.value : null });
      }
      const sorted = targets.filter(t => t.start != null).map(t => t.start).sort((p, q) => p - q);
      const entries = [];
      for (const t of targets) {
        if (t.start == null || t.k === 0) continue;
        const nxt = sorted.find(v => v > t.start);
        entries.push({ k: t.k, start: t.start, end: nxt !== undefined && nxt < cont ? nxt : cont });
      }
      const ds = (j >= 2 && this.insns[j - 2].name === 'Ldar' && this.insns[j - 2].ops[0] === msg && this.insns[j - 1].name === 'SetPendingMessage') ? this.insns[j - 2].off : x.off;
      return { dispatchStart: ds, entries, cont };
    }
  }
  let dispatchStart = null, jf = null;
  for (; i !== undefined && i < this.insns.length - 1; i++) {
    const a = this.insns[i], b = this.insns[i + 1];
    const c = this.insns[i + 2], d = this.insns[i + 3], e = this.insns[i + 4];
    if (a.name === 'LdaZero' && b.name === 'TestReferenceEqual' && b.ops[0] === tok && c && /^JumpIfFalse(Constant)?$/.test(c.name) && d && d.name === 'Ldar' && d.ops[0] === msg) {
      dispatchStart = a.off; jf = c; break;
    }
    if (a.name === 'Ldar' && a.ops[0] === msg && b && b.name === 'SetPendingMessage' && c && c.name === 'LdaZero' && d && d.name === 'TestReferenceEqual' && d.ops[0] === tok && e && /^JumpIfFalse(Constant)?$/.test(e.name)) {
      dispatchStart = a.off; jf = e; break;
    }
  }
  if (!jf) return null;
  const entries = [];
  let idx = this.idxAt(this.jt(jf));
  let contOff = this.insns[idx] ? this.insns[idx].off : this.bc.length;
  for (;;) {
    const a = this.insns[idx], b = this.insns[idx + 1], c = this.insns[idx + 2];
    if (!(a && b && c && a.name === 'LdaSmi' && b.name === 'TestReferenceEqual' && b.ops[0] === tok && /^JumpIfFalse(Constant)?$/.test(c.name))) break;
    const endOff = this.jt(c);
    entries.push({ k: a.ops[0], start: c.off + c.len, end: endOff });
    idx = this.idxAt(endOff);
    contOff = this.insns[idx] ? this.insns[idx].off : this.bc.length;
  }
  if (!entries.length && this.insns[idx] && this.insns[idx].name === 'Mov') {
    let rIdx = idx;
    while (rIdx < idx + 5 && this.insns[rIdx] && this.insns[rIdx].name !== 'Return') rIdx++;
    if (this.insns[rIdx]?.name === 'Return') {
      entries.push({ k: 1, start: this.insns[idx].off, end: this.insns[rIdx].off + this.insns[rIdx].len });
    }
  }
  return { dispatchStart, entries, cont: contOff };
};
P.matchForOf = function (ins, i, iterable) {
  const q = this.insns;
  const a = q[i + 1], b = q[i + 2], c = q[i + 3];
  if (!(a && starReg(a) !== null && b && b.name === 'GetNamedProperty' && c && starReg(c) !== null)) return null;
  const h = this.handlers.find(x => x.start > ins.off && x.start < ins.off + 40 && this.parseFinallyPrologue(x.handler) && this.loopHeads && this.loopHeads.has(x.start));
  if (!h) return null;
  return { iterable, H: h.start, handler: h };
};
P.matchArrayDestruct = function (ins, i, iterable, st, out) {
  const q = this.insns;
  const a = q[i + 1], b = q[i + 2], c = q[i + 3];
  if (!(a && starReg(a) !== null && b && b.name === 'GetNamedProperty' && c && starReg(c) !== null)) return null;
  const h = this.handlers.find(x => x.start > ins.off && x.start < ins.off + 40 && this.parseFinallyPrologue(x.handler) && (!this.loopHeads || !this.loopHeads.has(x.start)));
  if (!h) return null;
  const pro = this.parseFinallyPrologue(h.handler);
  const disp = pro && this.parseDispatch(pro.fb, pro.tok, pro.exc, pro.msg);
  if (!disp) return null;
  const ops = [];
  for (let m = this.at.get(h.start); m < q.length && q[m].off < h.end; m++) {
    if (q[m].name === 'LdaUndefined' && q[m + 1] && starReg(q[m + 1]) !== null) ops.push(starReg(q[m + 1]));
  }
  if (!ops.length) return null;
  this.flush(st, out);
  st.acc = null;
  const names = ops.map(op => {
    const nm = this.newVar('d');
    st.regs.set(-7 - op, E.id(nm));
    return nm;
  });
  out.push({ t: 'var', kind: 'const', name: '[' + names.join(', ') + ']', e: iterable, destruct: names });
  if (!this.doneTry) this.doneTry = new Set();
  this.handlers.filter(x => x.start >= h.start && x.start < disp.cont).forEach(x => this.doneTry.add(x));
  return this.idxAt(disp.cont);
};
P.doForOf = function (h, st, out, loop) {
  this.commit(st, out);
  const fo = st.forOf; st.forOf = null;
  const pro = this.parseFinallyPrologue(h.handler);
  if (!pro) return null;
  const disp = this.parseDispatch(pro.fb, pro.tok, pro.exc, pro.msg);
  if (!disp) return null;
  const jl = this.loopHeads.get(h.start);
  let k = this.at.get(h.start);
  while (k < this.insns.length && !/^JumpIfToBooleanTrue(Constant)?$/.test(this.insns[k].name)) k++;
  const v1 = this.insns[k + 1], v2 = this.insns[k + 2];
  if (!(v1 && v1.name === 'GetNamedProperty' && v2 && starReg(v2) !== null)) return null;
  let b = k + 3;
  if (this.insns[b] && this.insns[b].name === 'LdaFalse' && starReg(this.insns[b + 1]) !== null) b += 2;
  const itemReg = -7 - starReg(v2);
  const itemRegs = new Set([itemReg]);
  if (this.insns[b]?.name === 'Mov' && -7 - this.insns[b].ops[0] === itemReg) {
    const r1 = -7 - this.insns[b].ops[1];
    itemRegs.add(r1);
    b++;
    if (this.insns[b]?.name === 'Mov' && -7 - this.insns[b].ops[0] === r1) {
      itemRegs.add(-7 - this.insns[b].ops[1]);
      b++;
    }
  }
  const bodyStart = this.insns[b].off;
  for (const r of this.regsWritten(bodyStart, jl.off)) {
    if (itemRegs.has(r) || !st.regs.has(r) || this.vars.has(r)) continue;
    const cur = st.regs.get(r);
    if (!cur || cur.k === 'undef' || cur.k === 'raw') continue;
    const live = this.firstAccessIsRead(r, bodyStart, jl.off) || this.firstAccessIsRead(r, disp.cont, this.bc.length);
    if (!live) continue;
    const n = this.newVar();
    out.push({ t: 'var', kind: 'let', name: n, e: cur });
    this.vars.set(r, n);
    st.regs.set(r, E.id(n));
  }
  const item = this.newVar('e');
  const stBody = this.clone(st);
  for (const ir of itemRegs) stBody.regs.set(ir, E.id(item));
  stBody.acc = null;
  const fin = { tok: pro.tok, exc: pro.exc, fb: pro.fb, fb2: pro.fb2, entries: disp.entries, cont: disp.cont, forOf: true };
  (this.finStack = this.finStack || []).push(fin);
  const ctx = { header: h.start, exit: jl.off + jl.len, exit2: disp.cont, cont: jl.off, parent: loop, label: null };
  const body = [];
  this.walk(bodyStart, jl.off, stBody, body, ctx);
  this.flush(stBody, body);
  this.finStack.pop();
  const sameH = this.handlers.filter(x => x.start >= h.start && x.start < disp.cont);
  sameH.forEach(x => this.doneTry.add(x));
  const stmt = { t: 'forin', decl: 'const', name: item, of: true, e: fo.iterable, body };
  if (ctx.label) stmt.label = ctx.label;
  out.push(stmt);
  st.acc = null;
  return this.idxAt(disp.cont);
};
P.tryFinally = function (h, st, out, loop) {
  this.commit(st, out);
  const pro = this.parseFinallyPrologue(h.handler);
  if (!pro) return null;
  const disp = this.parseDispatch(pro.fb, pro.tok, pro.exc, pro.msg);
  if (!disp) return null;
  const sameH = this.handlers.filter(x => x.handler === h.handler);
  sameH.forEach(x => this.doneTry.add(x));
  const tryEnd = Math.max(...sameH.map(x => x.end));
  const fin = { tok: pro.tok, exc: pro.exc, fb: pro.fb, fb2: pro.fb2, entries: disp.entries, cont: disp.cont };
  (this.finStack = this.finStack || []).push(fin);
  this.flush(st, out);
  const stT = this.clone(st); const oT = [];
  this.walk(h.start, tryEnd, stT, oT, loop);
  this.flush(stT, oT);
  this.finStack.pop();
  const stF = this.clone(st); const oF = [];
  stF.acc = null;
  this.walk(pro.fb, disp.dispatchStart, stF, oF, loop);
  this.flush(stF, oF);
  { const base = new Map(st.regs); const insertAt = out.length; out.push({ t: 'try', body: oT, catchBody: null, finallyBody: oF }); if (!terminal(oT)) this.mergeRegs(st, out, insertAt, [stT], [oT], disp.cont, base); }
  st.acc = null;
  st.chain = stT.chain;
  return this.idxAt(disp.cont);
};
P.doTry = function (h, i, end, st, out, loop) {
  this.doneTry.add(h);
  this.commit(st, out);
  if (this.parseFinallyPrologue(h.handler)) {
    const r = st.forOf && st.forOf.H === h.start ? this.doForOf(h, st, out, loop) : this.tryFinally(h, st, out, loop);
    if (r !== null) return r;
  }
  const sameH = this.handlers.filter(x => x.handler === h.handler);
  sameH.forEach(x => this.doneTry.add(x));
  const tryEnd = Math.max(...sameH.map(x => x.end));
  const stT = this.clone(st); const oT = [];
  this.flush(st, out);
  this.walk(h.start, tryEnd, stT, oT, loop);
  this.flush(stT, oT);
  const ti = this.at.get(tryEnd);
  let after = null;
  const jl = ti !== undefined ? this.insns[ti] : null;
  if (jl && this.isUncond(jl) && this.jt(jl) > h.handler) after = this.jt(jl);
  const catchEnd = after !== null ? after : end;
  const stC = this.clone(st);
  const exc = E.id('$exc');
  stC.acc = { e: exc, used: true };
  stC.chain = st.chain;
  const oC = [];
  this.catchState = { exc, param: null };
  const saved = this.catchState;
  this.walk(h.handler, catchEnd, stC, oC, loop);
  this.flush(stC, oC);
  const stmt = { t: 'try', body: oT, catchBody: oC, param: saved.param };
  const insertAt = out.length;
  const sts = [], outs = [];
  if (!terminal(oT)) { sts.push(stT); outs.push(oT); }
  if (!terminal(oC)) { sts.push(stC); outs.push(oC); }
  const base = new Map(st.regs);
  out.push(stmt);
  if (sts.length) this.mergeRegs(st, out, insertAt, sts, outs, catchEnd, sts.length === 1 ? base : undefined);
  st.acc = null;
  if (after !== null) { st.chain = stT.chain; return this.at.get(after); }
  return this.at.get(end) !== undefined ? this.at.get(end) : this.insns.length;
};
