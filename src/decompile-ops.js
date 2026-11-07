'use strict';
const { FnDec, neg, hasEffect, BIN, TEST, TYPEOF, jkind, isStar } = require('./decompile');
const { E } = require('./ast');
const P = FnDec.prototype;

const REGFLAGS = ['d', 'g', 'i', 'm', 's', 'u', 'v', 'y'];
const RX = { g: 1, i: 2, m: 4, y: 8, u: 16, s: 32, d: 128, v: 256 };
const sameExpr = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

P.regList = function (st, startOp, count) {
  const out = [];
  for (let j = 0; j < count; j++) out.push(this.regExpr(st, startOp - j));
  return out;
};
P.constExpr = function (v, st) {
  switch (v.kind) {
    case 'smi': return E.lit(v.value);
    case 'num': return E.lit(v.value);
    case 'bigint': return E.raw(v.value);
    case 'str': return E.lit(v.value);
    case 'undef': return E.undef();
    case 'null': return E.lit(null);
    case 'true': return E.lit(true);
    case 'false': return E.lit(false);
    case 'hole': case 'uninit': return E.hole();
    case 'sfi': return this.closure(v.obj, st);
    case 'objdesc': return this.objLiteral(v.obj, st);
    case 'arrdesc': return this.arrLiteral(v.obj);
    case 'classdesc': return { k: 'classdesc', obj: v.obj };
    default: return E.raw('undefined /*const:' + (v.type || v.kind) + '*/');
  }
};
P.closure = function (sfiObj, st) {
  const child = this.prog.sfi(sfiObj);
  if (!child.bc) return E.raw('(function () { /*lazy function*/ })');
  const d = new FnDec(this.prog, child, st.chain, { ...this.cfg, moduleWrapper: false });
  const info = d.run();
  return E.fn(info);
};
P.objLiteral = function (o) {
  const props = [];
  const start = this.prog.bcMap <= 43 ? 3 : 4;
  const n = (o.size - start) >> 1;
  for (let i = 0; i < n; i++) {
    const kv = this.prog.val(o.words[start + 2 * i]);
    const vv = this.prog.val(o.words[start + 1 + 2 * i]);
    const key = kv.kind === 'str' ? kv.value : kv.kind === 'smi' ? kv.value : '?';
    let value;
    if (vv.kind === 'uninit' || vv.kind === 'hole') value = null; else value = this.constExpr(vv, { chain: this.chain0 });
    props.push({ key, value, kind: value ? 'init' : 'pending', computed: false });
  }
  return E.obj(props);
};
P.arrLiteral = function (o) {
  const w = o.words[2];
  const fa = w && w.t === 'obj' ? this.prog.h.objs[w.id] : null;
  const elems = [];
  if (fa) {
    const len = (fa.words[1].v | 0) >> 1;
    for (let i = 0; i < len; i++) {
      const v = this.prog.val(fa.words[2 + i]);
      elems.push(v.kind === 'hole' || v.kind === 'uninit' ? null : this.constExpr(v, { chain: this.chain0 }));
    }
    if (fa.words[2] && fa.words[2].t === 'raw' && !fa.words[2].w8 && (fa.size - 2) * 4 >= len * 8 && fa.words.every(x => x.t === 'raw')) {
      elems.length = 0;
      const { rawBytes } = require('./heap');
      const b = rawBytes(fa, 2, fa.size);
      for (let i = 0; i < len; i++) elems.push(E.lit(b.readDoubleLE(i * 8)));
    }
  }
  return E.arr(elems);
};
P.fresh = function (e) {
  if (e.k === 'obj') return E.obj(e.props.map(p => ({ ...p })));
  if (e.k === 'arr') return E.arr(e.elems.slice());
  return e;
};
P.materialize = function (st, out) {
  const a = st.acc;
  if (a && !a.used && hasEffect(a.e)) {
    const n = this.newVar();
    out.push({ t: 'var', kind: 'const', name: n, e: a.e });
    this.tempDefs.set(n, a.e);
    st.acc = { e: E.id(n), used: false };
  }
};
P.emitStore = function (st, out, target) {
  this.materialize(st, out);
  const v = this.take(st);
  if (v.k === 'hole') return;
  if (v.k === 'fn' && v.info.name && !v.info.isClass && /^(Normal|Async|Gen|AsyncGen)$/.test(v.info.kind) && target.k === 'id' && target.name === v.info.name) { out.push({ t: 'fndecl', info: v.info }); return; }
  out.push({ t: 'expr', e: E.assign(target, v) });
};
P.keyOf = function (v) { return v.kind === 'str' ? v.value : v.kind === 'smi' ? String(v.value) : '?'; };

P.step = function (ins, i, end, st, out, loop, ifctx) {
  const n = ins.name, o = ins.ops;
  const RAW = (op) => this.regExpr(st, op);
  const R = (op) => this.readReg(st, op, out);
  const put = (e) => this.put(st, e, out);
  const nextI = i + 1;

  if (isStar(n)) {
    const op = n === 'Star' ? o[0] : -7 - Number(n.slice(4));
    if (this.finStack && this.finStack.length) {
      const f = this.finStack.find(x => x.tok === op);
      if (f) { const a = st.acc && st.acc.e; if (a && a.k === 'lit' && typeof a.v === 'number') st.token = { k: a.v, fin: f }; return nextI; }
      const fe = this.finStack.find(x => x.exc === op);
      if (fe) { const e = this.take(st); st.regs.set(-7 - op, e); st.acc = { e, used: true }; return nextI; }
    }
    this.materialize(st, out);
    const e = this.take(st);
    if (this.skipRegs && this.skipRegs.has(-7 - op)) return nextI;
    if (e.chain) { st.regs.set(-7 - op, e); return nextI; }
    this.setReg(st, op, e, out);
    if (st.regs.has(-7 - op)) st.acc = { e: st.regs.get(-7 - op), used: true };
    return nextI;
  }
  if (BIN[n]) { const r = this.take(st); put(E.bin(BIN[n], R(o[0]), r)); return nextI; }
  if (/Smi$/.test(n) && BIN[n.slice(0, -3)]) { const l = this.take(st); put(E.bin(BIN[n.slice(0, -3)], l, E.lit(o[0]))); return nextI; }
  if (TEST[n]) { const r = this.take(st); put(E.bin(TEST[n], R(o[0]), r)); return nextI; }

  switch (n) {
    case 'LdaZero': put(E.lit(0)); return nextI;
    case 'LdaSmi': put(E.lit(o[0])); return nextI;
    case 'LdaUndefined': put(E.undef()); return nextI;
    case 'LdaNull': put(E.lit(null)); return nextI;
    case 'LdaTheHole': put(E.hole()); return nextI;
    case 'LdaTrue': put(E.lit(true)); return nextI;
    case 'LdaFalse': put(E.lit(false)); return nextI;
    case 'LdaConstant': put(this.fresh(this.constExpr(this.poolv(o[0]), st))); return nextI;
    case 'Ldar': put(R(o[0])); return nextI;
    case 'Mov': {
      if (o[0] === -1) { st.ctxRegs.set(-7 - o[1], st.chain); return nextI; }
      const e = R(o[0]);
      if (this.skipRegs && this.skipRegs.has(-7 - o[1])) return nextI;
      if (e.chain) { st.regs.set(-7 - o[1], e); return nextI; }
      if (o[1] > -7) return nextI;
      this.setReg(st, o[1], e, out);
      return nextI;
    }
    case 'LdaGlobal': case 'LdaGlobalInsideTypeof': { const v = this.poolv(o[0]); put(E.id(this.keyOf(v))); return nextI; }
    case 'StaGlobal': { const v = this.poolv(o[0]); this.emitStore(st, out, E.id(this.keyOf(v))); return nextI; }
    case 'LdaContextSlot': case 'LdaImmutableContextSlot': case 'LdaScriptContextSlot': case 'LdaImmutableScriptContextSlot': put(this.ctxVar(st, o[0], o[1], o[2])); return nextI;
    case 'LdaCurrentContextSlot': case 'LdaImmutableCurrentContextSlot': case 'LdaCurrentScriptContextSlot': put(this.ctxVar(st, undefined, o[0], 0)); return nextI;
    case 'StaContextSlot': case 'StaScriptContextSlot': this.emitStore(st, out, this.ctxVar(st, o[0], o[1], o[2])); return nextI;
    case 'StaCurrentContextSlot': case 'StaCurrentScriptContextSlot': this.emitStore(st, out, this.ctxVar(st, undefined, o[0], 0)); return nextI;
    case 'LdaLookupSlot': case 'LdaLookupSlotInsideTypeof': case 'LdaLookupGlobalSlot': case 'LdaLookupGlobalSlotInsideTypeof': put(E.id(this.keyOf(this.poolv(o[0])))); return nextI;
    case 'LdaLookupContextSlot': case 'LdaLookupContextSlotInsideTypeof': case 'LdaLookupScriptContextSlot': case 'LdaLookupScriptContextSlotInsideTypeof': put(E.id(this.keyOf(this.poolv(o[0])))); return nextI;
    case 'StaLookupSlot': this.emitStore(st, out, E.id(this.keyOf(this.poolv(o[0])))); return nextI;

    case 'GetNamedProperty': { put(E.member(R(o[0]), this.keyOf(this.poolv(o[1])))); return nextI; }
    case 'GetNamedPropertyFromSuper': { put(E.member(E.id('super'), this.keyOf(this.poolv(o[1])))); return nextI; }
    case 'GetKeyedProperty': { const k = this.take(st); put(E.index(R(o[0]), k)); return nextI; }
    case 'SetNamedProperty': this.emitStore(st, out, E.member(R(o[0]), this.keyOf(this.poolv(o[1])))); return nextI;
    case 'SetKeyedProperty': { this.materialize(st, out); const v = this.take(st); out.push({ t: 'expr', e: E.assign(E.index(R(o[0]), R(o[1])), v) }); st.acc = { e: v, used: true }; return nextI; }
    case 'DefineNamedOwnProperty': case 'DefineKeyedOwnProperty': case 'DefineKeyedOwnPropertyInLiteral': {
      this.materialize(st, out);
      const v = this.take(st);
      const target = RAW(o[0]);
      const key = n === 'DefineNamedOwnProperty' ? this.keyOf(this.poolv(o[1])) : null;
      const kexpr = key === null ? R(o[1]) : null;
      this.defineProp(target, key, kexpr, v, out);
      st.acc = { e: v, used: true };
      return nextI;
    }
    case 'StaInArrayLiteral': {
      this.materialize(st, out);
      const v = this.take(st); const arr = RAW(o[0]); const idx = R(o[1]);
      if (arr.k === 'arr' && idx.k === 'lit') { while (arr.elems.length < idx.v) arr.elems.push(null); arr.elems[idx.v] = v; }
      else out.push({ t: 'expr', e: E.assign(E.index(arr, idx), v) });
      st.acc = { e: v, used: true };
      return nextI;
    }
    case 'Inc': { const a = this.take(st); put(E.bin('+', a, E.lit(1))); return nextI; }
    case 'Dec': { const a = this.take(st); put(E.bin('-', a, E.lit(1))); return nextI; }
    case 'Negate': { const a = this.take(st); put(E.un('-', a)); return nextI; }
    case 'BitwiseNot': { const a = this.take(st); put(E.un('~', a)); return nextI; }
    case 'ToBooleanLogicalNot': case 'LogicalNot': { const a = this.take(st); put((a.k === 'arr' && !a.elems.length) ? E.lit(false) : neg(a)); return nextI; }
    case 'TypeOf': { const a = this.take(st); put(E.un('typeof', a)); return nextI; }
    case 'DeletePropertyStrict': case 'DeletePropertySloppy': { const k = this.take(st); put(E.un('delete', E.index(R(o[0]), k))); return nextI; }
    case 'TestNull': { const a = this.take(st); put(E.bin('===', a, E.lit(null))); return nextI; }
    case 'TestUndefined': { const a = this.take(st); put(E.bin('===', a, E.undef())); return nextI; }
    case 'TestUndetectable': { const a = this.take(st); put(E.bin('==', a, E.lit(null))); return nextI; }
    case 'TestTypeOf': { const a = this.take(st); put(E.bin('===', E.un('typeof', a), E.lit(TYPEOF[o[0]] || 'object'))); return nextI; }
    case 'ToBoolean': { const a = st.acc && st.acc.e; if (a && a.k === 'arr' && !a.elems.length) { this.take(st); put(E.lit(true)); } return nextI; }
    case 'ToNumber': { const a = this.take(st); put(E.un('+', a)); return nextI; }
    case 'ToNumeric': case 'ToName': return nextI;
    case 'ToString': { const a = this.take(st); put(E.tostr(a)); return nextI; }
    case 'ToObject': { const a = this.take(st); if (o[0] <= -7) this.setReg(st, o[0], a, out); st.acc = { e: a, used: true }; return nextI; }
    case 'GetSuperConstructor': {
      if (this.insns[i + 1]?.name === 'ThrowIfNotSuperConstructor') {
        let cIns = null, mIdx = -1;
        for (let k = i + 1; k < Math.min(this.insns.length, i + 15); k++) {
          if (/^Construct/.test(this.insns[k].name)) cIns = this.insns[k];
          if (this.insns[k].name === 'Mov' && this.insns[k].ops[1] === 2) { mIdx = k; break; }
        }
        if (cIns && mIdx > i) {
          let args = this.regList(st, cIns.ops[1], cIns.ops[2]);
          if (cIns.name === 'ConstructWithSpread' && args.length) args[args.length - 1] = E.spread(args[args.length - 1]);
          this.flush(st, out);
          out.push({ t: 'expr', e: E.call(E.id('super'), args) });
          st.acc = null;
          return mIdx + 1;
        }
      }
      put(E.id('super'));
      return nextI;
    }

    case 'CallProperty': case 'CallAnyReceiver': case 'CallUndefinedReceiver': case 'CallWithSpread': {
      const callee = R(o[0]); const list = this.regList(st, o[1], o[2]);
      return this.finishCall(callee, n === 'CallUndefinedReceiver' ? null : list[0], n === 'CallUndefinedReceiver' ? list : list.slice(1), n === 'CallWithSpread', st, out, nextI);
    }
    case 'CallProperty0': return this.finishCall(R(o[0]), R(o[1]), [], false, st, out, nextI);
    case 'CallProperty1': return this.finishCall(R(o[0]), R(o[1]), [R(o[2])], false, st, out, nextI);
    case 'CallProperty2': return this.finishCall(R(o[0]), R(o[1]), [R(o[2]), R(o[3])], false, st, out, nextI);
    case 'CallUndefinedReceiver0': return this.finishCall(R(o[0]), null, [], false, st, out, nextI);
    case 'CallUndefinedReceiver1': return this.finishCall(R(o[0]), null, [R(o[1])], false, st, out, nextI);
    case 'CallUndefinedReceiver2': return this.finishCall(R(o[0]), null, [R(o[1]), R(o[2])], false, st, out, nextI);
    case 'Construct': case 'ConstructWithSpread': {
      let args = this.regList(st, o[1], o[2]);
      if (n === 'ConstructWithSpread' && args.length) args[args.length - 1] = E.spread(args[args.length - 1]);
      this.take(st);
      put(E.new_(R(o[0]), args));
      return nextI;
    }
    case 'CallRuntime': case 'CallRuntimeForPair': {
      const args = this.regList(st, o[1], o[2]);
      this.take(st);
      if ((args[0]?.k === 'classdesc' || (o[0] >= 41 && o[0] <= 50)) && args.length >= 3) {
        const cls = this.buildClass(args, st, out);
        if (cls) { this.flush(st, out); st.acc = { e: cls, used: true }; return nextI; }
      }
      put(E.call(E.id('%Runtime' + o[0]), args));
      return nextI;
    }
    case 'FindNonDefaultConstructorOrConstruct': {
      let cIns = null, mIdx = -1;
      for (let k = i + 1; k < Math.min(this.insns.length, i + 15); k++) {
        if (/^Construct/.test(this.insns[k].name)) cIns = this.insns[k];
        if (this.insns[k].name === 'Mov' && this.insns[k].ops[1] === 2) { mIdx = k; break; }
      }
      if (cIns && mIdx > i) {
        let args = this.regList(st, cIns.ops[1], cIns.ops[2]);
        if (cIns.name === 'ConstructWithSpread' && args.length) args[args.length - 1] = E.spread(args[args.length - 1]);
        this.flush(st, out);
        out.push({ t: 'expr', e: E.call(E.id('super'), args) });
        st.acc = null;
        return mIdx + 1;
      }
      return nextI;
    }
    case 'CallJSRuntime': { const args = this.regList(st, o[1], o[2]); put(E.call(E.id('%JSRuntime' + o[0]), args)); return nextI; }
    case 'InvokeIntrinsic': {
      const args = this.regList(st, o[1], o[2]);
      const id = this.prog.retCode <= 0xae ? ({ 0: 0, 1: 0, 2: 1, 3: 2, 4: 3, 11: 9, 14: 12 }[o[0]] ?? o[0]) : o[0];
      switch (id) {
        case 1: put({ k: 'raw', text: '/*async-state*/' }); return nextI;
        case 0: put(E.await_(args[1])); return nextI;
        case 3: put(args[1]); return nextI;
        case 2: put({ k: 'raw', text: '/*reject*/', reject: true }); return nextI;
        case 9: put(E.lit(0)); return nextI;
        case 12: {
          const obj = args[0]?.k === 'obj' ? args[0] : (args[0]?.k === 'id' && this.tempDefs.get(args[0].name)?.k === 'obj' ? this.tempDefs.get(args[0].name) : null);
          if (obj && args[1]) obj.props.push({ kind: 'spread', value: args[1] });
          put(args[0] || E.undef());
          return nextI;
        }
      }
      put(E.call(E.id('%Intrinsic' + o[0]), args)); return nextI;
    }

    case 'CreateClosure': put(this.constExpr(this.poolv(o[0]), st)); {
      const e = st.acc.e;
      return nextI;
    }
    case 'CreateObjectLiteral': put(this.fresh(this.constExpr(this.poolv(o[0]), st))); return nextI;
    case 'CreateEmptyObjectLiteral': put(E.obj([])); return nextI;
    case 'CreateArrayLiteral': put(this.fresh(this.constExpr(this.poolv(o[0]), st))); return nextI;
    case 'CreateEmptyArrayLiteral': put(E.arr([])); return nextI;
    case 'CreateArrayFromIterable': { const a = this.take(st); put(E.arr([E.spread(a)])); return nextI; }
    case 'CloneObject': put(E.obj([{ kind: 'spread', value: R(o[0]) }])); return nextI;
    case 'CreateRegExpLiteral': {
      const pat = this.keyOf(this.poolv(o[0]));
      let fl = '';
      for (const c of 'dgimsuvy') if (o[2] & RX[c]) fl += c;
      put(E.regexp(pat, fl)); return nextI;
    }
    case 'GetTemplateObject': put(E.raw('/*template-object*/')); return nextI;

    case 'CreateFunctionContext': case 'CreateBlockContext': {
      const sv = this.poolv(o[0]);
      const sc = sv.kind === 'scope' ? this.prog.scope(sv.obj) : (n === 'CreateFunctionContext' ? this.sfi.scope : null);
      this.flush(st, out);
      const ctx = { k: 'raw', text: '/*ctx*/', chain: [sc || { names: [], extSlot: 0 }, ...st.chain] };
      st.acc = { e: ctx, used: true };
      if (sc) this.declScope(sc, out, n === 'CreateFunctionContext');
      return nextI;
    }
    case 'CreateCatchContext': {
      const sv = this.poolv(o[1]);
      const sc = sv.kind === 'scope' ? this.prog.scope(sv.obj) : { names: ['e'], extSlot: 0, modes: ['let'] };
      { const ex = R(o[0]); if (this.catchState && ex === this.catchState.exc) { ex.name = sc.names[0] || 'e'; this.catchState.param = ex.name; } }
      this.flush(st, out);
      st.acc = { e: { k: 'raw', text: '/*catchctx*/', chain: [sc, ...st.chain], catchVar: sc.names[0] }, used: true };
      return nextI;
    }
    case 'CreateWithContext': {
      const sv = this.poolv(o[1]);
      const sc = sv.kind === 'scope' ? this.prog.scope(sv.obj) : { names: [], extSlot: 0 };
      this.flush(st, out);
      st.acc = { e: { k: 'raw', text: '/*withctx*/', chain: [sc, ...st.chain], withObj: R(o[0]) }, used: true };
      return nextI;
    }
    case 'PushContext': {
      const a = st.acc && st.acc.e;
      st.ctxRegs.set(-7 - o[0], st.chain);
      if (a && a.chain) st.chain = a.chain;
      return nextI;
    }
    case 'PopContext': {
      const c = st.ctxRegs.get(-7 - o[0]);
      st.chain = c || st.chain.slice(1);
      return nextI;
    }
    case 'CreateMappedArguments': case 'CreateUnmappedArguments': put(E.id('arguments')); return nextI;
    case 'CreateRestParameter': put(E.id('rest')); return nextI;

    case 'ThrowReferenceErrorIfHole': case 'ThrowSuperNotCalledIfHole': case 'ThrowSuperAlreadyCalledIfNotHole': case 'ThrowIfNotSuperConstructor':
    case 'IncBlockCounter': case 'SetPendingMessage': case 'Wide': case 'ExtraWide': return nextI;
    case 'Debugger': out.push({ t: 'expr', e: E.raw('debugger') }); return nextI;
    case 'Return': { const e = this.take(st); out.push({ t: 'return', e: e.k === 'undef' ? null : e }); return nextI; }
    case 'Throw': case 'ReThrow': { const e = this.take(st); out.push({ t: 'throw', e }); return nextI; }
    case 'Abort': out.push({ t: 'comment', text: 'abort' }); return nextI;

    case 'ForInEnumerate': { const e = R(o[0]); this.flush(st, out); st.acc = { e: { k: 'raw', text: '/*forin*/', forinObj: e }, used: true }; return nextI; }
    case 'ForInPrepare': { const a = this.take(st); for (let j = 0; j < 3; j++) st.regs.set(-7 - (o[0] - j), { k: 'raw', text: '/*forin-state*/', forinObj: a.forinObj || a }); return nextI; }
    case 'ForInNext': {
      const objE = R(o[0]);
      const fo = (st.regs.get(-7 - o[2]) || {}).forinObj || objE;
      const key = st.forinKey || (st.forinKey = this.newVar('k'));
      this.flush(st, out);
      if (loop && !loop.forin) loop.forin = { key, obj: fo };
      st.acc = { e: E.id(key), used: false, forinKey: key, forinObj: fo };
      return nextI;
    }
    case 'ForInStep': return nextI;
    case 'GetIterator': {
      const obj = R(o[0]);
      { const fo = this.matchForOf(ins, i, obj); if (fo) { st.forOf = fo; this.flush(st, out); st.acc = null; return this.idxAt(fo.H); } }
      { const ad = this.matchArrayDestruct(ins, i, obj, st, out); if (ad !== null) return ad; }
      this.flush(st, out);
      st.acc = { e: E.call(E.index(obj, E.member(E.id('Symbol'), 'iterator')), [], obj), used: false };
      return nextI;
    }
    case 'Jump': case 'JumpConstant': case 'JumpLoop':
      return this.doJump(ins, i, end, st, out, loop);
    case 'SwitchOnSmiNoFeedback': { out.push({ t: 'comment', text: 'switch-table' }); return nextI; }
    case 'SwitchOnGeneratorState': case 'SuspendGenerator': case 'ResumeGenerator': return nextI;
  }
  if (this.isCond(ins)) return this.doCond(ins, i, end, st, out, loop, ifctx);
  out.push({ t: 'comment', text: 'unsupported ' + n + ' ' + o.join(',') });
  return nextI;
};

P.defineProp = function (target, key, kexpr, v, out) {
  const obj = target.k === 'obj' ? target : (target.k === 'id' && this.tempDefs.get(target.name) && this.tempDefs.get(target.name).k === 'obj' ? this.tempDefs.get(target.name) : null);
  if (obj) {
    if (key !== null) {
      const p = obj.props.find(x => x.kind === 'pending' && x.key === key);
      if (p) { p.value = v; p.kind = 'init'; return; }
      obj.props.push({ key, value: v, kind: 'init', computed: false });
    } else obj.props.push({ key: kexpr, value: v, kind: 'init', computed: true });
    return;
  }
  out.push({ t: 'expr', e: E.call(E.member(E.id('Object'), 'defineProperty'), [target, key !== null ? E.lit(key) : kexpr, E.obj([{ key: 'value', value: v, kind: 'init' }, { key: 'enumerable', value: E.lit(true), kind: 'init' }, { key: 'writable', value: E.lit(true), kind: 'init' }, { key: 'configurable', value: E.lit(true), kind: 'init' }])]) });
};
P.finishCall = function (callee, recv, args, spreadLast, st, out, nextI) {
  this.take(st);
  if (spreadLast && args.length) args = args.slice(0, -1).concat([E.spread(args[args.length - 1])]);
  let e;
  const def = callee.k === 'id' ? this.tempDefs.get(callee.name) : callee;
  const shape = def && (def.k === 'member' || def.k === 'index') ? def : null;
  if (!recv || recv.k === 'undef' || (recv.k === 'id' && recv.name === 'undefined')) e = E.call(callee, args);
  else if (shape && sameExpr(shape.obj, recv)) e = E.call(callee, args);
  else e = E.call(E.member(callee, 'call'), [recv, ...args]);
  this.put(st, e, out);
  return nextI;
};
P.declScope = function (sc, out, isFn) {
  const by = {};
  sc.names.forEach((nm, i) => { if (nm) (by[sc.modes[i] || 'let'] = by[sc.modes[i] || 'let'] || []).push(nm); });
  for (const k of Object.keys(by)) out.push({ t: 'decl', kind: k, names: by[k], fnScope: isFn });
};
P.buildClass = function (args, st, out) {
  const val = (a) => (a && a.k === 'id' && this.tempDefs.has(a.name)) ? this.tempDefs.get(a.name) : a;
  const cb = val(args[0]), ctor = val(args[1]);
  const sup = args[2] && args[2].k !== 'hole' ? args[2] : null;
  if (!cb || cb.k !== 'classdesc' || !ctor || ctor.k !== 'fn') return null;
  const methods = [];
  const scanDesc = (w, isStatic) => {
    if (!w || w.t !== 'obj') return;
    const d = this.prog.h.objs[w.id];
    const p0 = this.prog.h.W === 8 ? 3 : 4;
    for (let p = p0; p + 2 < d.words.length; p += 3) {
      const kv = this.prog.val(d.words[p]);
      if (kv.kind !== 'str' || ['constructor', 'length', 'name', 'prototype'].includes(kv.value)) continue;
      const v1 = this.prog.val(d.words[p + 1]), v2 = this.prog.val(d.words[p + 2]);
      if (v2.obj && v2.obj.size === 3) {
        for (const w of [v2.obj.words[1], v2.obj.words[2]]) {
          const av = this.prog.val(w);
          if (av.kind === 'smi' && av.value >= 3 && av.value < args.length && val(args[av.value])?.k === 'fn') {
            methods.push({ idx: av.value, key: kv.value, computed: false, static: isStatic, fn: val(args[av.value]) });
          }
        }
        continue;
      }
      const idx = (v2.kind === 'smi' && v2.value >= 3 && v2.value < args.length && val(args[v2.value])?.k === 'fn') ? v2.value
                : (v1.kind === 'smi' && v1.value >= 3 && v1.value < args.length && val(args[v1.value])?.k === 'fn') ? v1.value : -1;
      if (idx >= 3) methods.push({ idx, key: kv.value, computed: false, static: isStatic, fn: val(args[idx]) });
    }
  };
  const scanComp = (w, isStatic) => {
    if (!w || w.t !== 'obj') return;
    const c = this.prog.h.objs[w.id];
    for (let p = 2; p < c.words.length; p++) {
      const idx = (c.words[p].v | 0) >> 3;
      if (idx >= 3 && idx + 1 < args.length && val(args[idx + 1])?.k === 'fn') {
        const kExpr = val(args[idx]);
        const unlit = kExpr && kExpr.k === 'lit' && typeof kExpr.v === 'string';
        methods.push({ idx, key: unlit ? kExpr.v : args[idx], computed: !unlit, static: isStatic, fn: val(args[idx + 1]) });
      }
    }
  };
  const cs = cb.obj.size === 9 ? 1 : 0;
  scanDesc(cb.obj.words[2 + cs], true);
  scanDesc(cb.obj.words[5 + cs], false);
  scanComp(cb.obj.words[4 + cs], true);
  scanComp(cb.obj.words[7 + cs], false);
  methods.sort((a, b) => a.idx - b.idx);
  const b = ctor.info.body;
  if (b.length && b[b.length - 1].t === 'return' && b[b.length - 1].e && b[b.length - 1].e.k === 'id' && b[b.length - 1].e.name === 'this') b.pop();
  const ctorIdx = args[1] && args[1].k === 'id' ? out.findIndex(s => s.t === 'var' && s.name === args[1].name) : -1;
  if (ctorIdx >= 0) {
    const sub = (e, nm, rpl) => {
      if (!e || typeof e !== 'object') return e;
      if (e.k === 'id' && e.name === nm) return rpl;
      if (e.k === 'fn') return e;
      const c = Array.isArray(e) ? e.slice() : { ...e };
      for (const k of Object.keys(c)) {
        if (Array.isArray(c[k])) c[k] = c[k].map(x => sub(x, nm, rpl));
        else if (c[k] && typeof c[k] === 'object') c[k] = sub(c[k], nm, rpl);
      }
      return c;
    };
    for (let j = out.length - 1; j > ctorIdx; j--) {
      const s = out[j];
      if (s.t === 'var' && s.name && s.name[0] === '$') {
        for (const m of methods) if (m.computed && m.key) m.key = sub(m.key, s.name, s.e);
      }
    }
    out.splice(ctorIdx + 1);
  }
  ctor.info.isClass = true;
  ctor.info.superClass = sup;
  ctor.info.methods = methods;
  return args[1];
};

require('./decompile-flow');
