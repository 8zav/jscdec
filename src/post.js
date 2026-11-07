'use strict';
const { E, ID } = require('./ast');

const EFFECT = new Set(['call', 'new', 'assign', 'await', 'yield']);
const isTemp = (n) => typeof n === 'string' && n[0] === '$';
const isParam = (n) => typeof n === 'string' && /^[ab]\d+$/.test(n);
const isObfName = (n) => typeof n === 'string' && /^_0x[0-9a-f]+$/i.test(n);
const RESERVED = new Set('break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static await arguments undefined NaN Infinity'.split(' '));

function kids(e) {
  switch (e.k) {
    case 'member': return [['obj', e.obj]];
    case 'index': return [['obj', e.obj], ['key', e.key]];
    case 'call': return [['fn', e.fn], ...e.args.map((a, i) => [i, a])];
    case 'new': return [['fn', e.fn], ...e.args.map((a, i) => [i, a])];
    case 'bin': case 'logic': return [['l', e.l], ['r', e.r]];
    case 'un': case 'tostr': case 'spread': case 'await': return [['e', e.e]];
    case 'yield': return e.e ? [['e', e.e]] : [];
    case 'cond': return [['c', e.c], ['a', e.a], ['b', e.b]];
    case 'assign': return [['target', e.target], ['value', e.value]];
    case 'arr': return e.elems.map((x, i) => [i, x]).filter(x => x[1]);
    case 'obj': return e.props.flatMap((p, i) => [...(p.computed ? [[`k${i}`, p.key]] : []), [`v${i}`, p.value]]).filter(x => x[1]);
    case 'tmpl': return e.parts.map((x, i) => [i, x]).filter(x => typeof x[1] === 'object');
    case 'fn': {
      const out = [];
      if (e.info && e.info.superClass) out.push(['super', e.info.superClass]);
      if (e.info && e.info.methods) e.info.methods.forEach((m, i) => { if (m.computed && m.key) out.push([`mk${i}`, m.key]); });
      return out;
    }
    default: return [];
  }
}
function setKid(e, key, v) {
  if (typeof key === 'number') { (e.args || e.elems || e.parts)[key] = v; return; }
  if (key === 'super') { e.info.superClass = v; return; }
  if (/^mk\d+$/.test(key)) { e.info.methods[+key.slice(2)].key = v; return; }
  if (/^k\d+$/.test(key)) { e.props[+key.slice(1)].key = v; return; }
  if (/^v\d+$/.test(key)) { e.props[+key.slice(1)].value = v; return; }
  e[key] = v;
}
function mapExpr(e, f) {
  if (!e || typeof e !== 'object') return e;
  for (const [k, c] of kids(e)) { const n = mapExpr(c, f); if (n !== c) setKid(e, k, n); }
  return f(e) || e;
}
function stmtExprs(s) {
  const r = [];
  const add = (obj, key) => { if (obj[key] && typeof obj[key] === 'object' && obj[key].k) r.push([obj, key]); };
  switch (s.t) {
    case 'expr': case 'return': case 'throw': add(s, 'e'); break;
    case 'var': add(s, 'e'); break;
    case 'if': case 'while': case 'dowhile': add(s, 'c'); break;
    case 'for': add(s, 'c'); break;
    case 'forin': add(s, 'e'); break;
    case 'switch': add(s, 'd'); break;
  }
  return r;
}
function childBlocks(s) {
  const r = [];
  switch (s.t) {
    case 'if': r.push(s.a); if (s.b) r.push(s.b); break;
    case 'while': case 'dowhile': case 'for': case 'forin': r.push(s.body); break;
    case 'try': r.push(s.body); if (s.catchBody) r.push(s.catchBody); if (s.finallyBody) r.push(s.finallyBody); break;
    case 'switch': for (const c of s.cases) r.push(c.body); break;
    case 'fndecl': r.push(s.info.body); break;
  }
  return r;
}
function fnBodies(e, acc) {
  if (!e) return;
  if (e.k === 'fn') {
    acc.push(e.info);
    if (e.info.methods) for (const m of e.info.methods) if (m.fn && m.fn.info) acc.push(m.fn.info);
  }
  for (const [, c] of kids(e)) fnBodies(c, acc);
}
function eachExprDeep(blockList, f) {
  for (const s of blockList) {
    for (const [o, k] of stmtExprs(s)) f(o, k);
    for (const b of childBlocks(s)) eachExprDeep(b, f);
  }
}
function walkExpr(e, f) {
  if (!e || typeof e !== 'object') return;
  f(e);
  for (const [, c] of kids(e)) walkExpr(c, f);
}
function walkNoFn(e, f) {
  if (!e || typeof e !== 'object') return;
  f(e);
  if (e.k === 'fn') return;
  for (const [, c] of kids(e)) walkNoFn(c, f);
}
function collectFnDecls(blockList, acc) {
  for (const s of blockList) {
    if (s.t === 'fndecl') acc.push(s.info);
    for (const b of childBlocks(s)) collectFnDecls(b, acc);
  }
}

function stripWrapperPrologue(body, isTop = false) {
  for (const s of body) if (s.t !== 'fndecl') for (const b of childBlocks(s)) stripWrapperPrologue(b, false);
  for (let i = body.length - 1; i >= 0; i--) {
    const s = body[i];
    if (s.t === 'decl') {
      s.names = s.names.filter(n => !['this', 'require', '__dirname', '__filename', 'module', 'exports'].includes(n));
      if (!s.names.length) { body.splice(i, 1); continue; }
    } else if (s.t === 'expr' && s.e.k === 'assign' && s.e.op === '=' && s.e.target.k === 'id' && s.e.value.k === 'id' && s.e.target.name === s.e.value.name) {
      body.splice(i, 1);
    } else if (isTop && s.t === 'return' && (!s.e || s.e.k === 'undef') && i === body.length - 1) {
      body.pop();
    }
  }
}

function reorderHoistedFunctions(body) {
  for (const s of body) if (s.t !== 'fndecl') for (const b of childBlocks(s)) reorderHoistedFunctions(b);
  const fns = [];
  const rest = [];
  let seenNonFn = false;
  for (const s of body) {
    if (!seenNonFn && s.t === 'fndecl' && s.info.start != null) fns.push(s);
    else {
      if (s.t !== 'decl') seenNonFn = true;
      rest.push(s);
    }
  }
  if (!fns.length || !rest.some(s => s.pos != null && s.pos > 30)) return;
  let lastPos = 0;
  for (const s of rest) {
    if (s.pos != null && s.pos >= lastPos) lastPos = s.pos;
    s._pos = lastPos;
  }
  const isModuleExports = (s) => s.t === 'expr' && s.e.k === 'assign' && s.e.target.k === 'member' && s.e.target.obj.k === 'id' && s.e.target.obj.name === 'module' && s.e.target.prop === 'exports';
  for (const fn of fns) {
    const start = fn.info.start;
    let idx = rest.findIndex(s => s._pos > start || isModuleExports(s));
    if (idx < 0) rest.push(fn);
    else rest.splice(idx, 0, fn);
  }
  body.length = 0;
  body.push(...rest);
}

function countIds(body, counts, writes) {
  for (const s of body) {
    for (const [o, k] of stmtExprs(s)) walkExpr(o[k], (n) => {
      if (n.k === 'id') counts.set(n.name, (counts.get(n.name) || 0) + 1);
      if (writes && n.k === 'assign' && n.target.k === 'id') writes.set(n.target.name, (writes.get(n.target.name) || 0) + 1);
      if (writes && n.k === 'un' && (n.op === '++' || n.op === '--') && n.e.k === 'id') writes.set(n.e.name, (writes.get(n.e.name) || 0) + 1);
    });
    if (s.t !== 'fndecl') for (const b of childBlocks(s)) countIds(b, counts, writes);
  }
}

function foldShortCircuit(list) {
  for (const s of list) for (const b of childBlocks(s)) foldShortCircuit(b);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i + 1 < list.length; i++) {
      const d = list[i], f = list[i + 1];
      if (d.t === 'var' && isTemp(d.name) && f.t === 'if' && !f.b && f.a.length === 1) {
        const a0 = f.a[0];
        if (a0.t === 'expr' && a0.e.k === 'assign' && a0.e.op === '=' && a0.e.target.k === 'id' && a0.e.target.name === d.name) {
          const rhs = a0.e.value;
          if (f.c.k === 'id' && f.c.name === d.name) {
            list.splice(i, 2, { t: 'var', kind: 'const', name: d.name, e: E.logic('&&', d.e, rhs), pos: d.pos });
            changed = true; break;
          }
          if (f.c.k === 'un' && f.c.op === '!' && f.c.e.k === 'id' && f.c.e.name === d.name) {
            list.splice(i, 2, { t: 'var', kind: 'const', name: d.name, e: E.logic('||', d.e, rhs), pos: d.pos });
            changed = true; break;
          }
          if (f.c.k === 'bin' && f.c.op === '==' && f.c.l.k === 'id' && f.c.l.name === d.name && f.c.r.k === 'lit' && f.c.r.v === null) {
            list.splice(i, 2, { t: 'var', kind: 'const', name: d.name, e: E.logic('??', d.e, rhs), pos: d.pos });
            changed = true; break;
          }
        }
      }
      if (d.t === 'decl' && d.names.length === 1 && isTemp(d.names[0]) && f.t === 'if' && f.b) {
        const n = d.names[0];
        const one = (arr) => arr.length === 1 && arr[0].t === 'expr' && arr[0].e.k === 'assign' && arr[0].e.target.k === 'id' && arr[0].e.target.name === n ? arr[0].e.value : null;
        const a = one(f.a), b = one(f.b);
        if (a && b) {
          list.splice(i, 2, { t: 'var', kind: 'const', name: n, e: { k: 'cond', c: f.c, a, b }, pos: d.pos });
          changed = true; break;
        }
      }
    }
  }
}

function foldOptionalChaining(body) {
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const attachOpt = (expr, target) => {
    if (same(expr, target)) return expr;
    if (expr.k === 'member' && same(expr.obj, target)) return { ...expr, opt: true };
    if (expr.k === 'index' && same(expr.obj, target)) return { ...expr, opt: true };
    if (expr.k === 'call' && same(expr.fn, target)) return { ...expr, opt: true };
    if (expr.k === 'member') { const sub = attachOpt(expr.obj, target); if (sub !== expr.obj) return { ...expr, obj: sub }; }
    if (expr.k === 'index') { const sub = attachOpt(expr.obj, target); if (sub !== expr.obj) return { ...expr, obj: sub }; }
    if (expr.k === 'call') { const sub = attachOpt(expr.fn, target); if (sub !== expr.fn) return { ...expr, fn: sub }; }
    return null;
  };
  eachExprDeep(body, (o, k) => {
    o[k] = mapExpr(o[k], (n) => {
      if (n.k === 'cond') {
        if (n.c.k === 'bin' && n.c.op === '!=' && n.c.r.k === 'lit' && n.c.r.v === null && n.b.k === 'undef') {
          const r = attachOpt(n.a, n.c.l);
          if (r) return r;
        }
        if (n.c.k === 'bin' && n.c.op === '==' && n.c.r.k === 'lit' && n.c.r.v === null && n.a.k === 'undef') {
          const r = attachOpt(n.b, n.c.l);
          if (r) return r;
        }
      }
      return null;
    });
  });
}

function hasEff(e) {
  if (!e || typeof e !== 'object') return false;
  if (EFFECT.has(e.k) || (e.k === 'un' && (e.op === 'delete' || e.op === '++' || e.op === '--'))) return true;
  return kids(e).some(([, c]) => c && c.k !== 'fn' && hasEff(c));
}
function reachableFirst(e, T, st) {
  if (st.found || st.bad) return;
  if (e.k === 'id' && e.name === T) { st.found = true; if (st.seenEffect || st.cond) st.bad = true; return; }
  if (e.k === 'fn') return;
  if (e.k === 'logic') {
    reachableFirst(e.l, T, st);
    const c = st.cond; st.cond = true; reachableFirst(e.r, T, st); st.cond = c;
  } else if (e.k === 'cond') {
    reachableFirst(e.c, T, st);
    const c = st.cond; st.cond = true; reachableFirst(e.a, T, st); reachableFirst(e.b, T, st); st.cond = c;
  } else if (e.k === 'assign') {
    if (e.target.k === 'member') reachableFirst(e.target.obj, T, st);
    else if (e.target.k === 'index') { reachableFirst(e.target.obj, T, st); reachableFirst(e.target.key, T, st); }
    reachableFirst(e.value, T, st);
  } else {
    for (const [, c] of kids(e)) reachableFirst(c, T, st);
  }
  if (!st.found && (EFFECT.has(e.k) || (e.k === 'un' && e.op === 'delete'))) st.seenEffect = true;
}
function replaceId(e, T, repl) {
  return mapExpr(e, (n) => (n.k === 'id' && n.name === T ? repl : null));
}
function inlineBlock(list, counts, writes) {
  for (const s of list) if (s.t !== 'fndecl') for (const b of childBlocks(s)) inlineBlock(b, counts, writes);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = list.length - 2; i >= 0; i--) {
      const s = list[i];
      if (s.t !== 'var' || !isTemp(s.name) || (counts.get(s.name) || 0) !== 1 || (writes.get(s.name) || 0) > 0) continue;
      let j = i + 1, ok = true;
      for (; j < list.length; j++) {
        const c = list[j];
        const uses = stmtExprs(c).some(([o, k]) => { let f = false; walkExpr(o[k], n => { if (n.k === 'id' && n.name === s.name) f = true; }); return f; });
        if (uses) break;
        if (!(c.t === 'decl' || (c.t === 'var' && isTemp(c.name) && !hasEff(c.e)))) { ok = false; break; }
      }
      if (!ok || j >= list.length) continue;
      const cons = list[j];
      if (!['expr', 'var', 'return', 'throw', 'if', 'switch', 'forin'].includes(cons.t)) continue;
      const exprs = stmtExprs(cons);
      const impure = hasEff(s.e);
      if (impure) {
        const st = { seenEffect: false, found: false, bad: false, cond: false };
        for (const [o, k] of exprs) { reachableFirst(o[k], s.name, st); if (st.found) break; }
        if (!st.found || st.bad) continue;
      }
      let done = false;
      for (const [o, k] of exprs) { let f = false; walkExpr(o[k], n => { if (n.k === 'id' && n.name === s.name) f = true; }); if (f) { o[k] = replaceId(o[k], s.name, s.e); done = true; break; } }
      if (!done) continue;
      list.splice(i, 1);
      changed = true;
      break;
    }
  }
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (s.t === 'var' && isTemp(s.name) && !(counts.get(s.name) > 0)) {
      if (hasEff(s.e)) list[i] = { t: 'expr', e: s.e, pos: s.pos }; else list.splice(i, 1);
    }
  }
}

function usesName(s, name) {
  let f = false;
  const chk = (st) => {
    for (const [o, k] of stmtExprs(st)) walkNoFn(o[k], n => { if (n.k === 'id' && n.name === name) f = true; });
    if (st.t === 'forin' && st.name === name) f = true;
    if (st.t !== 'fndecl') for (const b of childBlocks(st)) b.forEach(chk);
  };
  chk(s);
  return f;
}
function foldDecls(list) {
  for (const s of list) for (const b of childBlocks(s)) foldDecls(b);
  for (let i = 0; i < list.length; i++) {
    const d = list[i];
    if (d.t !== 'decl') continue;
    const remaining = new Set(d.names);
    for (let j = i + 1; j < list.length && remaining.size; j++) {
      const s = list[j];
      if (s.t === 'fndecl' && remaining.has(s.info.name)) { remaining.delete(s.info.name); d.names.splice(d.names.indexOf(s.info.name), 1); continue; }
      if (s.t === 'expr' && s.e.k === 'assign' && s.e.op === '=' && s.e.target.k === 'id' && remaining.has(s.e.target.name)) {
        const nm = s.e.target.name;
        let used = false; walkExpr(s.e.value, n => { if (n.k === 'id' && n.name === nm) used = true; });
        if (!used) { list[j] = { t: 'var', kind: d.kind, name: nm, e: s.e.value, pos: s.pos }; remaining.delete(nm); continue; }
      }
      for (const nm of [...remaining]) if (usesName(s, nm)) remaining.delete(nm), d.names.splice(d.names.indexOf(nm), 1), d.names.push(nm), d._keep = (d._keep || new Set()).add(nm);
    }
    d.names = d.names.filter(n => {
      if (isTemp(n) && !list.slice(i + 1).some(st => usesName(st, n))) return false;
      return !(list.some(x => x.t === 'var' && x.name === n && list.indexOf(x) > i)) || (d._keep && d._keep.has(n));
    });
  }
  for (let i = list.length - 1; i >= 0; i--) if (list[i].t === 'decl' && !list[i].names.length) list.splice(i, 1);
}

function foldObjectDestruct(list, counts, writes) {
  for (const s of list) for (const b of childBlocks(s)) foldObjectDestruct(b, counts, writes);
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s.t === 'var' && !isTemp(s.name) && ID.test(s.name) && s.e && s.e.k === 'member' && s.e.prop === s.name && s.e.obj.k === 'call' && s.e.obj.fn.k === 'id' && s.e.obj.fn.name === 'require') {
      s.name = `{ ${s.name} }`;
      s.e = s.e.obj;
      continue;
    }
    if (s.t === 'var' && isTemp(s.name) && s.e) {
      const props = [];
      let j = i + 1;
      while (j < list.length) {
        const nx = list[j];
        if (nx.t === 'var' && nx.e && nx.e.k === 'member' && nx.e.obj.k === 'id' && nx.e.obj.name === s.name && ID.test(nx.e.prop) && !(writes && writes.get(nx.name) > 0)) {
          props.push({ prop: nx.e.prop, target: nx.name, kind: nx.kind, stmtIdx: j });
          j++;
        } else break;
      }
      if (props.length >= 2 && (counts.get(s.name) || 0) === props.length) {
        for (const p of props) {
          if (isTemp(p.target) && !props.some(o => o !== p && o.target === p.prop)) {
            for (let k = j; k < list.length; k++) {
              for (const [o, key] of stmtExprs(list[k])) o[key] = replaceId(o[key], p.target, E.id(p.prop));
              for (const b of childBlocks(list[k])) eachExprDeep(b, (o, key) => { o[key] = replaceId(o[key], p.target, E.id(p.prop)); });
            }
            p.target = p.prop;
          }
        }
        if (props.every(p => !isTemp(p.target))) {
          const fields = props.map(p => p.prop === p.target ? p.prop : `${p.prop}: ${p.target}`).join(', ');
          list.splice(i, 1 + props.length, { t: 'var', kind: props[0].kind || 'const', name: `{ ${fields} }`, e: s.e, pos: s.pos });
          continue;
        }
      }
    }
    if (s.t === 'var' && isTemp(s.name) && s.e && s.e.k === 'member' && s.e.obj.k === 'id' && isParam(s.e.obj.name) && ID.test(s.e.prop) && !(writes && writes.get(s.name) > 0)) {
      const paramName = s.e.obj.name;
      const props = [{ prop: s.e.prop, target: s.name, kind: s.kind }];
      let j = i + 1;
      while (j < list.length) {
        const nx = list[j];
        if (nx.t === 'var' && isTemp(nx.name) && nx.e && nx.e.k === 'member' && nx.e.obj.k === 'id' && nx.e.obj.name === paramName && ID.test(nx.e.prop) && !(writes && writes.get(nx.name) > 0)) {
          props.push({ prop: nx.e.prop, target: nx.name, kind: nx.kind });
          j++;
        } else break;
      }
      if (props.length >= 2) {
        for (const p of props) {
          for (let k = j; k < list.length; k++) {
            for (const [o, key] of stmtExprs(list[k])) o[key] = replaceId(o[key], p.target, E.id(p.prop));
            for (const b of childBlocks(list[k])) eachExprDeep(b, (o, key) => { o[key] = replaceId(o[key], p.target, E.id(p.prop)); });
          }
          p.target = p.prop;
        }
        const fields = props.map(p => p.prop).join(', ');
        list.splice(i, props.length, { t: 'var', kind: props[0].kind || 'const', name: `{ ${fields} }`, e: E.id(paramName), pos: s.pos });
      }
    }
  }
}

function foldCompoundAssign(body) {
  eachExprDeep(body, (o, k) => {
    o[k] = mapExpr(o[k], (n) => {
      if (n.k === 'assign' && n.op === '=' && (n.target.k === 'id' || n.target.k === 'member') && n.value.k === 'bin') {
        const sameTarget = JSON.stringify(n.target) === JSON.stringify(n.value.l);
        if (sameTarget) {
          const op = n.value.op;
          if (op === '+' && n.value.r.k === 'lit' && n.value.r.v === 1) return { k: 'un', op: '++', e: n.target, post: true };
          if (op === '-' && n.value.r.k === 'lit' && n.value.r.v === 1) return { k: 'un', op: '--', e: n.target, post: true };
          if (['+', '-', '*', '/', '%', '|', '&', '^', '<<', '>>', '>>>'].includes(op)) {
            return E.assign(n.target, n.value.r, op + '=');
          }
        }
      }
      return null;
    });
  });
}

function dropGuards(list) {
  for (const s of list) for (const b of childBlocks(s)) dropGuards(b);
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (s.t === 'if' && !s.b && s.a.every(x => x.t === 'expr' && x.e.k === 'call' && x.e.fn.k === 'id' && /^%Runtime(160|206)$/.test(x.e.fn.name))) list.splice(i, 1);
    if (s.t === 'if' && !s.b && s.c.k === 'bin' && s.c.op === '===' && s.c.l.k === 'lit' && s.c.r.k === 'lit' && s.c.l.v === s.c.r.v && s.a.length === 1 && s.a[0].t === 'continue') {
      if (i + 1 < list.length && list[i + 1].t === 'throw') list.splice(i, 2);
      else list.splice(i, 1);
    }
  }
}

function shapeLoops(list) {
  for (const s of list) for (const b of childBlocks(s)) shapeLoops(b);
  const { neg } = require('./decompile');
  const { expr } = require('./ast');
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (s.t === 'while' && s.c.k === 'lit' && s.c.v === true && s.body.length) {
      const f = s.body[0];
      if (f.t === 'if' && !f.b && f.a.length === 1 && f.a[0].t === 'break' && !f.a[0].label) {
        s.c = neg(f.c);
        s.body.shift();
      } else if (f.t === 'if' && f.b && !f.a.length && f.b.length === 1 && f.b[0].t === 'break' && !f.b[0].label) {
        s.c = f.c;
        s.body.shift();
      }
    }
    if (s.t === 'while' && s.c.k === 'lit' && s.c.v === true && s.body.length >= 3 && i >= 2) {
      const b = s.body;
      const innerWhileIdx = b.findIndex(x => x.t === 'while' && x.c.k === 'bin' && x.c.op === '==' && x.c.r.k === 'lit' && x.c.r.v === 1);
      if (innerWhileIdx >= 2) {
        const iw = b[innerWhileIdx];
        const flagName = iw.c.l.k === 'id' ? iw.c.l.name : null;
        const condIf = b.find((x, idx) => idx < innerWhileIdx && x.t === 'if' && ((x.b && !x.a.length && x.b.length === 1 && x.b[0].t === 'break') || (!x.b && x.a.length === 1 && x.a[0].t === 'break')));
        const firstIf = b.find((x, idx) => idx < innerWhileIdx && x.t === 'if' && x.c.k === 'bin' && x.c.op === '==' && x.c.l.k === 'id' && x.c.r.k === 'lit' && x.c.r.v === 1 && x.b);
        if (flagName && condIf && firstIf) {
          const firstVar = firstIf.c.l.name;
          let innerVar = null;
          if (b[0].t === 'var' && !b[0].e) innerVar = b[0].name;
          else if (b[0].t === 'decl' && b[0].names.length === 1) innerVar = b[0].names[0];
          else if (b[0].t === 'var' && b[0].e && b[0].e.k === 'id') innerVar = b[0].name;
          let outerVar = b[0].t === 'var' && b[0].e && b[0].e.k === 'id' ? b[0].e.name : null;
          if (!outerVar) {
            for (const st of firstIf.a) {
              if (st.t === 'expr' && st.e.k === 'assign' && st.e.target.k === 'id' && st.e.target.name === innerVar && st.e.value.k === 'id') outerVar = st.e.value.name;
              if (st.t === 'var' && st.name === innerVar && st.e && st.e.k === 'id') outerVar = st.e.name;
            }
          }
          const firstDeclIdx = list.findIndex((x, idx) => idx < i && idx >= i - 4 && x.t === 'var' && x.name === firstVar && x.e && x.e.k === 'lit' && x.e.v === 1);
          const outerDeclIdx = outerVar ? list.findIndex((x, idx) => idx < i && idx >= i - 4 && x.t === 'var' && x.name === outerVar) : -1;
          if (innerVar && firstDeclIdx >= 0 && outerDeclIdx >= 0) {
            const initExpr = list[outerDeclIdx].e;
            const condExpr = (condIf.b && !condIf.a.length) ? condIf.c : neg(condIf.c);
            const innerBody = iw.body.slice();
            const stripLoopLatch = (arr) => {
              while (arr.length) {
                const last = arr[arr.length - 1];
                if (last.t === 'expr' && last.e.k === 'assign' && last.e.target.k === 'id' && (last.e.target.name === flagName || last.e.target.name === outerVar || isTemp(last.e.target.name))) {
                  arr.pop();
                } else break;
              }
              const last = arr[arr.length - 1];
              if (last && last.t === 'try' && last.catchBody) stripLoopLatch(last.catchBody);
              if (last && last.t === 'if') {
                if (last.a) stripLoopLatch(last.a);
                if (last.b) stripLoopLatch(last.b);
              }
            };
            stripLoopLatch(innerBody);
            const forStmt = {
              t: 'for',
              init: `let ${innerVar} = ${expr(initExpr)}`,
              c: condExpr,
              update: `${innerVar}++`,
              body: innerBody,
              pos: s.pos
            };
            list[i] = forStmt;
            const toRemove = [firstDeclIdx, outerDeclIdx].sort((a, b) => b - a);
            for (const rIdx of toRemove) list.splice(rIdx, 1);
            i -= toRemove.length;
            continue;
          }
        }
      }
    }
    if (s.t === 'while' && i > 0 && list[i - 1].t === 'var' && list[i - 1].kind === 'let' && s.body.length) {
      const prev = list[i - 1];
      const vname = prev.name;
      const last = s.body[s.body.length - 1];
      const isInc = last.t === 'expr' && (
        (last.e.k === 'un' && (last.e.op === '++' || last.e.op === '--') && last.e.e.k === 'id' && last.e.e.name === vname) ||
        (last.e.k === 'assign' && last.e.target.k === 'id' && last.e.target.name === vname && (last.e.op === '+=' || last.e.op === '-='))
      );
      let condUses = false;
      walkExpr(s.c, n => { if (n.k === 'id' && n.name === vname) condUses = true; });
      let usedAfter = false;
      for (let k = i + 1; k < list.length; k++) if (usesName(list[k], vname)) { usedAfter = true; break; }
      if (isInc && condUses && !usedAfter) {
        s.body.pop();
        const forStmt = {
          t: 'for',
          init: `let ${vname} = ${expr(prev.e)}`,
          c: s.c,
          update: expr(last.e),
          body: s.body,
          label: s.label,
          pos: prev.pos
        };
        list.splice(i - 1, 2, forStmt);
        i--;
      }
    }
    const cur = list[i];
    if (cur && (cur.t === 'while' || cur.t === 'for' || cur.t === 'forin') && cur.body.length >= 2) {
      foldTrailingContinueGuards(cur.body);
    }
    if (cur && cur.t === 'forin' && cur.of && cur.body.length) {
      const f = cur.body[0];
      if (f.t === 'var' && f.destruct && f.e && f.e.k === 'id' && f.e.name === cur.name) {
        cur.destruct = f.destruct;
        cur.name = f.name;
        cur.body.shift();
      }
    }
  }
}

function foldTrailingContinueGuards(body) {
  const { neg } = require('./decompile');
  for (let i = body.length - 2; i >= 0; i--) {
    const s = body[i];
    if (s.t === 'if' && !s.b && s.a.length === 1 && s.a[0].t === 'continue' && !s.a[0].label) {
      const tail = body.slice(i + 1);
      if (tail.length <= 3) {
        const cond = neg(s.c);
        if (tail.length === 1 && tail[0].t === 'if' && !tail[0].b) {
          body.splice(i, 2, { t: 'if', c: E.logic('&&', cond, tail[0].c), a: tail[0].a, b: null });
        } else {
          body.splice(i, tail.length + 1, { t: 'if', c: cond, a: tail, b: null });
        }
      }
    }
  }
}

function flattenPlus(e, out) {
  if (e.k === 'bin' && e.op === '+') { flattenPlus(e.l, out); flattenPlus(e.r, out); } else out.push(e);
}
function templates(e) {
  return mapExpr(e, (n) => {
    if (n.k === 'bin' && n.op === '+') {
      const leaves = []; flattenPlus(n, leaves);
      if (!leaves.some(l => l.k === 'tostr' || l.k === 'tmpl')) return null;
      const parts = [];
      const addStr = (s) => { if (typeof parts[parts.length - 1] === 'string') parts[parts.length - 1] += s; else parts.push(s); };
      for (const l of leaves) {
        if (l.k === 'lit' && typeof l.v === 'string') addStr(l.v);
        else if (l.k === 'tmpl') l.parts.forEach(p => (typeof p === 'string' ? addStr(p) : parts.push(p)));
        else if (l.k === 'tostr') parts.push(l.e);
        else parts.push(l);
      }
      return { k: 'tmpl', parts };
    }
    return null;
  });
}
function applyTemplates(body) {
  eachExprDeep(body, (o, k) => { o[k] = templates(o[k]); });
}

function recoverParams(info) {
  const body = info.body;
  for (let i = 0; i < body.length; i++) {
    const s = body[i];
    if (s.t === 'var' && s.e && s.e.k === 'id' && isParam(s.e.name) && info.params.includes(s.e.name) && !isTemp(s.name)) {
      if (s.name.startsWith('{') && body.some((st, idx2) => idx2 !== i && usesName(st, s.e.name))) continue;
      if (isObfName(s.name)) {
        const oldName = s.name;
        const idx = info.params.indexOf(s.e.name);
        const hintName = (info.name && FN_PARAM_HINTS[info.name]?.[idx]) || (info._paramHints?.[idx]) || s.e.name;
        info.params[idx] = hintName;
        const repl = (list) => {
          for (const st of list) {
            for (const [o, k] of stmtExprs(st)) o[k] = mapExpr(o[k], n => {
              if (n.k === 'id' && n.name === oldName) return E.id(hintName);
              if (n.k === 'fn' && n.info?.body) {
                if (/^a\d+$/.test(hintName) && n.info.params.includes(hintName)) {
                  const subIdx = n.info.params.indexOf(hintName);
                  const subNew = 'b' + subIdx;
                  n.info.params[subIdx] = subNew;
                  const replSub = (subList) => {
                    for (const sst of subList) {
                      for (const [so, sk] of stmtExprs(sst)) so[sk] = mapExpr(so[sk], sn => (sn.k === 'id' && sn.name === hintName ? E.id(subNew) : null));
                      for (const sb of childBlocks(sst)) replSub(sb);
                    }
                  };
                  replSub(n.info.body);
                }
                if (!n.info.params.includes(oldName)) repl(n.info.body);
              }
              return null;
            });
            for (const b of childBlocks(st)) repl(b);
          }
        };
        repl(body.slice(i + 1));
        body.splice(i, 1); i--;
        continue;
      }
      const idx = info.params.indexOf(s.e.name);
      info.params[idx] = s.name;
      body.splice(i, 1); i--;
    } else if (s.t === 'var' && !isTemp(s.name) && s.e && s.e.k === 'cond' && s.e.c.k === 'bin' && s.e.c.op === '===' && s.e.c.l.k === 'id' && isParam(s.e.c.l.name) && s.e.c.r.k === 'undef' && s.e.b.k === 'id' && s.e.b.name === s.e.c.l.name && info.params.includes(s.e.c.l.name)) {
      const { expr } = require('./ast');
      const idx = info.params.indexOf(s.e.c.l.name);
      info.params[idx] = `${s.name} = ${expr(s.e.a)}`;
      body.splice(i, 1); i--;
    } else if (s.t === 'var' && isTemp(s.name) && s.e && s.e.k === 'cond' && s.e.c.k === 'bin' && s.e.c.op === '===' && s.e.c.l.k === 'id' && isParam(s.e.c.l.name) && s.e.c.r.k === 'undef' && s.e.b.k === 'id' && s.e.b.name === s.e.c.l.name && info.params.includes(s.e.c.l.name)) {
      const { expr } = require('./ast');
      const idx = info.params.indexOf(s.e.c.l.name);
      const pName = (info.name && FN_PARAM_HINTS[info.name]?.[idx]) || s.e.c.l.name;
      info.params[idx] = `${pName} = ${expr(s.e.a)}`;
      for (let k = i + 1; k < body.length; k++) {
        for (const [o, key] of stmtExprs(body[k])) o[key] = replaceId(o[key], s.name, E.id(pName));
        for (const b of childBlocks(body[k])) eachExprDeep(b, (o, key) => { o[key] = replaceId(o[key], s.name, E.id(pName)); });
      }
      body.splice(i, 1); i--;
    }
  }
}

function cleanIdent(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.replace(/^.*[/\\]/, '').replace(/\.[a-z0-9]+$/i, '');
  s = s.replace(/[^a-zA-Z0-9_$]+(.)?/g, (_, c) => (c ? c.toUpperCase() : '')).replace(/^[^a-zA-Z_$]+/, '');
  if (!s || RESERVED.has(s) || !ID.test(s)) return null;
  return s;
}

function inferCallReturnName(fnName) {
  if (!fnName || typeof fnName !== 'string') return null;
  const raw = fnName.replace(/^_+/, '');
  if (!raw) return null;
  const exact = {
    FileToHex: 'fileBuf',
    DecryptFile: 'decrypted',
    DecryptBuffer: 'decBuf',
    CalculateClientKey: 'clientKey',
    DecryptResourceFile: 'fileRes',
    GetDirectories: 'dirs',
    GetAllFiles: 'files',
    ValidateKey: 'grantsData',
    findGrantsFile: 'grantsFile',
    runTokenScan: 'scanOut',
    resolveViaFrontendApi: 'resolvedUrl',
    checkStillValid: 'status',
    unpacked: 'unpackedPath',
    safeName: 'safeDirName',
    applyFix: 'fixedBuf',
    getData: 'rawData',
    findFiveMPath: 'fiveMPath',
    decodeURIComponent: 'decoded',
    encodeURIComponent: 'encoded',
  };
  if (exact[raw]) return exact[raw];
  const m = /^(?:get|fetch|load|find|read|resolve|calc|calculate|compute|create|build|make|parse|extract|check|validate|verify|decrypt|encrypt|format|scan|run)([A-Z][a-zA-Z0-9]*)$/.exec(raw);
  if (m) {
    const noun = m[1][0].toLowerCase() + m[1].slice(1);
    if (ID.test(noun) && !RESERVED.has(noun)) return noun;
  }
  const c = raw[0].toLowerCase() + raw.slice(1);
  if (ID.test(c) && !RESERVED.has(c) && c.length > 2) return c + 'Res';
  return null;
}

function inferExprName(e, map) {
  if (!e || typeof e !== 'object') return null;
  if (e.k === 'id') {
    const nm = (map && map.get(e.name)) || e.name;
    if (nm && !isTemp(nm) && !isParam(nm) && !isObfName(nm) && !RESERVED.has(nm)) return nm;
    return null;
  }
  if (e.k === 'await' || e.k === 'un' || e.k === 'tostr') return inferExprName(e.e, map);
  if (e.k === 'logic') {
    const l = (e.l && e.l.k !== 'lit' && e.l.k !== 'undef') ? inferExprName(e.l, map) : null;
    const r = (e.r && e.r.k !== 'lit' && e.r.k !== 'undef') ? inferExprName(e.r, map) : null;
    return l || r;
  }
  if (e.k === 'cond') {
    const a = (e.a && e.a.k !== 'lit' && e.a.k !== 'undef' && e.a.k !== 'id') ? inferExprName(e.a, map) : null;
    const b = (e.b && e.b.k !== 'lit' && e.b.k !== 'undef' && e.b.k !== 'id') ? inferExprName(e.b, map) : null;
    return a || b || inferExprName(e.a, map) || inferExprName(e.b, map);
  }
  if (e.k === 'call') {
    if (e.fn.k === 'id') {
      if (e.fn.name === 'require' && e.args[0]?.k === 'lit') return cleanIdent(e.args[0].v);
      if (e.fn.name === 'checkHWID') return 'authResult';
      if (e.fn.name === 'fetchUpdateInfo') return 'updateInfo';
      if (e.fn.name === 'loadStoredKey') return 'key';
      if (e.fn.name === 'machineIdSync') return 'hwid';
      if (e.fn.name === 'listProcessNames') return 'procs';
      if (e.fn.name === 'countModels') return 'counts';
      const byFn = inferCallReturnName(e.fn.name);
      if (byFn) return byFn;
    }
    if (e.fn.k === 'member') {
      const p = e.fn.prop;
      const objName = e.fn.obj.k === 'id' ? e.fn.obj.name : '';
      if (p === 'toLowerCase' || p === 'toUpperCase' || p === 'trim' || p === 'replace' || p === 'substring' || p === 'substr') {
        const inner = inferExprName(e.fn.obj);
        if (inner && inner !== 'parts' && inner !== 'slice') return inner;
        if (p === 'trim') return 'trimmed';
      }
      if (p === 'toString') {
        if (e.args[0]?.k === 'lit' && e.args[0].v === 'hex') return 'hex';
        return inferExprName(e.fn.obj) || 'str';
      }
      if (p === 'toFixed') return 'formatted';
      if (p === 'endsWith' || p === 'startsWith') {
        const lit = e.args[0]?.k === 'lit' && typeof e.args[0].v === 'string' ? cleanIdent(e.args[0].v) : null;
        if (lit && lit.length <= 8) return 'is' + lit[0].toUpperCase() + lit.slice(1);
        return 'matched';
      }
      if (p === 'readdirSync' || p === 'readdir') return 'entries';
      if (p === 'statSync' || p === 'stat') return 'stat';
      if (p === 'readFileSync' || p === 'readFile') return 'data';
      if (p === 'createWriteStream') return 'stream';
      if (p === 'createDecipheriv') return 'decipher';
      if (p === 'createCipheriv') return 'cipher';
      if (p === 'decrypt') return 'decrypted';
      if (p === 'encrypt') return 'encrypted';
      if (p === 'randomBytes') return 'iv';
      if (p === 'stringify' && objName === 'JSON') return 'payload';
      if (p === 'parse' && objName === 'JSON') return 'parsed';
      if (p === 'digest') {
        let isHmac = false;
        walkExpr(e.fn.obj, n => { if (n.k === 'member' && n.prop === 'createHmac') isHmac = true; });
        return isHmac ? 'sig' : 'hash';
      }
      if (p === 'createHmac') return 'hmac';
      if (p === 'createHash') return 'hash';
      if (p === 'join') return 'fullPath';
      if (p === 'resolve') return 'resolvedPath';
      if (p === 'dirname') return 'dir';
      if (p === 'basename') return 'base';
      if (p === 'extname') return 'ext';
      if (p === 'relative') return 'relPath';
      if (p === 'now' && objName === 'Date') return 'startTime';
      if (p === 'entries' && objName === 'Object') return 'entries';
      if (p === 'keys' && objName === 'Object') return 'keys';
      if (p === 'values' && objName === 'Object') return 'values';
      if (p === 'all' && objName === 'Promise') return 'results';
      if (p === 'get' || p === 'post') return 'res';
      if (p === 'match') return 'match';
      if (p === 'split') return 'parts';
      if (p === 'pop' || p === 'shift') return 'part';
      if (p === 'find') return 'found';
      if (p === 'filter') return 'filtered';
      if (p === 'map') return 'mapped';
      if (p === 'reduce') return 'total';
      if (p === 'ceil' && objName === 'Math') return 'chunkSize';
      if (p === 'min' && objName === 'Math') return 'limit';
      if (p === 'max' && objName === 'Math') return 'maxVal';
      if (p === 'readUInt16LE' || p === 'readUInt16BE') return 'u16';
      if (p === 'readUInt32LE' || p === 'readUInt32BE') return 'u32';
      if (p === 'readBigUInt64LE' || p === 'readBigUInt64BE') return 'u64';
      if (p === 'readFloatLE') return 'floatLE';
      if (p === 'readFloatBE') return 'floatBE';
      if (p === 'slice' || p === 'subarray') return 'slice';
      if (p === 'from' && objName === 'Buffer') return 'buf';
      if (p === 'alloc' && objName === 'Buffer') return 'buf';
      if (p === 'getConfiguration') return 'resources';
      if (p === 'fetchEngine') return 'engineDir';
      if (p === 'getStoredKey') return 'licenseKey';
      if (p === 'callAuth') return 'res';
      const byMethod = inferCallReturnName(p);
      if (byMethod) return byMethod;
    }
    if (e.fn.k === 'fn' && e.fn.info?.kind === 'AsyncArrow') return 'task';
  }
  if (e.k === 'new') {
    if (e.fn.k === 'id') {
      if (e.fn.name === 'Date') return 'now';
      if (e.fn.name === 'Promise') return 'out';
      const c = e.fn.name[0].toLowerCase() + e.fn.name.slice(1);
      if (ID.test(c) && !RESERVED.has(c)) return c;
    }
    if (e.fn.k === 'call' && e.fn.fn.k === 'id' && e.fn.fn.name === 'require' && e.fn.args[0]?.k === 'lit') {
      return cleanIdent(e.fn.args[0].v);
    }
    return 'instance';
  }
  if (e.k === 'member' && ID.test(e.prop)) {
    if (e.obj.k === 'member' && e.obj.prop === 'env' && /^[A-Z0-9_]+$/.test(e.prop)) {
      const camel = e.prop.toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
      if (ID.test(camel) && !RESERVED.has(camel)) return camel;
    }
    const p = e.prop.replace(/^m_(?:p|dw|w|b)?/, '').replace(/^_+/, '');
    const c = p ? p[0].toLowerCase() + p.slice(1) : e.prop;
    if (ID.test(c) && !RESERVED.has(c) && c.length > 1) return c;
  }
  if (e.k === 'index') {
    if (e.obj.k === 'id') {
      const nm = (map && map.get(e.obj.name)) || e.obj.name;
      return singularize(nm);
    }
    if (e.obj.k === 'member' && ID.test(e.obj.prop)) {
      const p = e.obj.prop.replace(/^m_(?:p|dw|w|b)?/, '').replace(/^_+/, '');
      return singularize(p[0].toLowerCase() + p.slice(1));
    }
    const objHint = inferExprName(e.obj, map);
    if (objHint) return singularize(objHint);
  }
  if (e.k === 'bin') {
    const rName = e.r.k === 'id' ? ((map && map.get(e.r.name)) || e.r.name) : '';
    const lName = e.l.k === 'id' ? ((map && map.get(e.l.name)) || e.l.name) : '';
    if (e.op === '-' && /start|time/i.test(rName)) return 'elapsedMs';
    if (e.op === '*' && /size|stride/i.test(rName)) return 'offset';
    if (e.op === '+' && /offset/i.test(lName)) return 'fieldOffset';
    if (e.op === '+' && e.r.k === 'call' && e.r.fn.k === 'member' && /readUInt/.test(e.r.fn.prop)) return 'offset';
    let hasDate = false;
    walkExpr(e, n => { if (n.k === 'member' && (n.prop === 'getFullYear' || n.prop === 'padStart')) hasDate = true; });
    if (hasDate) return 'timestamp';
  }
  if (e.k === 'tmpl') {
    const strParts = e.parts.filter(p => typeof p === 'string').join('');
    if (/https?:\/\/|\/files\/|\?hash=/i.test(strParts)) return 'url';
    if (/\.exe$/i.test(strParts)) return 'exeName';
    return 'formattedStr';
  }
  if (e.k === 'obj') {
    const keys = e.props.filter(p => !p.computed && typeof p.key === 'string').map(p => p.key);
    if (keys.includes('headers') || keys.includes('timeout') || keys.includes('responseType')) return 'reqOpts';
    if (keys.includes('dumped') || keys.includes('decrypted') || keys.includes('fixed')) return 'stats';
    if (keys.includes('title') || keys.includes('properties') || keys.includes('defaultPath')) return 'dialogOpts';
    if (keys.includes('id') && keys.includes('key')) return 'keyInfo';
    return 'opts';
  }
  if (e.k === 'fn') return 'fn';
  if (e.k === 'arr') return 'list';
  return null;
}

function singularize(pl) {
  if (!pl || typeof pl !== 'string') return 'item';
  if (/entries$/i.test(pl)) return 'entry';
  if (/ies$/i.test(pl)) return pl.slice(0, -3) + 'y';
  if (/dirs$/i.test(pl)) return 'dir';
  if (/files$/i.test(pl)) return 'file';
  if (/s$/i.test(pl) && pl.length > 2 && !/ss$/i.test(pl)) return pl.slice(0, -1);
  return 'item';
}

const FN_PARAM_HINTS = {
  unpacked: ['p'],
  resolveUnpacked: ['subDir'],
  sanitizeError: ['msg'],
  logToFile: ['level', 'msg'],
  send: ['channel', 'data'],
  scanFixerInput: ['inputDir'],
  countModels: ['dir'],
  walk: ['dir'],
  collect: ['dir'],
  copyDirRecursive: ['srcDir', 'destDir'],
  _copyDirSync: ['src', 'dest'],
  _walkDir: ['dir', 'cb'],
  _getDirectories: ['dir'],
  _watermarkManifests: ['dir'],
  _logFile: ['level', 'msg'],
  log: ['stage', 'type', 'message'],
  run: ['config'],
  _finish: ['stats'],
  _runDump: ['cfxLink', 'resourceNames', 'workDir'],
  _runDecrypt: ['workDir', 'grantsFile'],
  _runFix: ['workDir'],
  compareVersions: ['a', 'b'],
  scheduleReplace: ['oldExe', 'newExe', 'tempFile'],
  checkAndApplyUpdate: ['currentVersion'],
  killProcess: ['name'],
  reportDetection: ['label', 'procName'],
  storeKey: ['key'],
  callAuth: ['backendUrl', 'key', 'hwid', 'isHeartbeat'],
  ensureLicensed: ['opts'],
  fetchEngine: ['hwid'],
  xorBytes: ['buf'],
  safeName: ['name'],
  resolveServer: ['input'],
  connect: ['cfxLink'],
  _downloadWithRetry: ['url', 'key', 'iv', 'destPath'],
  _downloadDecrypt: ['url', 'key', 'iv', 'destPath'],
  _unpackRpf: ['rpfPath', 'outDir'],
  clearEscrowInOriginal: ['vertexBuffer'],
  vertexDataNeedsSwap: ['vertexBuffer'],
  applyVertexFix: ['vertexBuffer'],
  fixGeometries: ['items'],
  processDrawable: ['drawable'],
  processFragDrawable: ['fd'],
  processFile: ['inputPath', 'outputPath'],
  swapEndianness: ['vertexBuffer'],
  swapWord: ['buf', 'off'],
  swapDWord: ['buf', 'off'],
  overridePaths: ['opts'],
  initializePaths: ['config'],
  FileToHex: ['filePath'],
  ScanForId: ['buf'],
  VerifyEncrypted: ['filePath'],
  DecryptFile: ['filePath', 'key'],
  DecryptBuffer: ['buf', 'key'],
  CalculateClientKey: ['clkBuf', 'resourceId'],
  ValidateDecryption: ['buf'],
  ProcessLuaFile: ['buf', 'outputPath', 'resourceName', 'relPath'],
  DecryptResourceFile: ['resourceDir', 'relPath', 'keyInfo', 'resourceName', 'grantsData'],
  GetAllFiles: ['dirPath'],
  GetDirectories: ['dirPath'],
  ValidateKey: ['keySource'],
  DecryptResource: ['resourceDir', 'resourceName', 'grantsObj'],
  startDecryption: ['config'],
};

function inferFnNoun(fnName) {
  if (!fnName || typeof fnName !== 'string') return null;
  const m = /^(?:process|handle|parse|validate|verify|check|hash|load|save|fetch|format|render|create|build|update|delete|remove|find|get|set|compute|calc|encode|decode|encrypt|decrypt|sign)([A-Z][a-zA-Z0-9]*?)(?:And[A-Z].*)?$/.exec(fnName);
  if (!m) return null;
  const noun = m[1][0].toLowerCase() + m[1].slice(1);
  if (noun === 'payload' || noun === 'and') return null;
  return ID.test(noun) && !RESERVED.has(noun) ? noun : null;
}

function rename(info, usedOuter = new Set(), outerObfMap = new Map()) {
  const names = new Set(usedOuter);
  const propHints = new Map();
  const paramUsageHints = new Map();
  const assignHints = new Map();
  const sinkHints = new Map();
  const counterVars = new Set();
  const hasTokenStr = [];
  const collect = (body) => eachExprDeep(body, (o, k) => walkExpr(o[k], n => {
    if (n.k === 'id' && !isTemp(n.name) && !isParam(n.name) && !isObfName(n.name)) names.add(n.name);
    if (n.k === 'lit' && typeof n.v === 'string' && /token/i.test(n.v)) hasTokenStr.push(true);
    if (n.k === 'fn' && n.info) {
      if (n.info.methods) for (const m of n.info.methods) if (!m.computed && typeof m.key === 'string' && !m.fn.info.name) m.fn.info.name = m.key;
    }
    if (n.k === 'un' && (n.op === '++' || n.op === '--') && n.e.k === 'id' && isTemp(n.e.name)) {
      counterVars.add(n.e.name);
    }
    if (n.k === 'assign') {
      if ((n.op === '+=' || n.op === '-=') && n.target.k === 'id' && isTemp(n.target.name)) {
        counterVars.add(n.target.name);
      }
      if (n.op === '=' && n.target.k === 'id' && (isTemp(n.target.name) || isObfName(n.target.name))) {
        const rhsHint = inferExprName(n.value) || (n.value.k === 'id' && assignHints.get(n.value.name));
        if (rhsHint && !assignHints.has(n.target.name)) assignHints.set(n.target.name, rhsHint);
      }
      if (n.op === '=' && n.target.k === 'member' && ID.test(n.target.prop) && n.value.k === 'id') {
        const cleanProp = n.target.prop.replace(/^_+/, '');
        if ((isParam(n.value.name) || isObfName(n.value.name)) && n.target.obj.k === 'id' && n.target.obj.name === 'this') {
          if (!paramUsageHints.has(n.value.name)) paramUsageHints.set(n.value.name, cleanProp);
        }
        if ((isTemp(n.value.name) || isObfName(n.value.name)) && cleanProp && ID.test(cleanProp) && !RESERVED.has(cleanProp)) {
          if (!sinkHints.has(n.value.name)) sinkHints.set(n.value.name, cleanProp);
        }
      }
      if (n.op === '=' && n.target.k === 'id' && !isTemp(n.target.name) && !isParam(n.target.name) && !isObfName(n.target.name) && n.value.k === 'id' && isTemp(n.value.name)) {
        if (!sinkHints.has(n.value.name)) sinkHints.set(n.value.name, n.target.name);
      }
    }
    if (n.k === 'obj') {
      for (const p of n.props) {
        if (!p.computed && typeof p.key === 'string' && ID.test(p.key) && p.value?.k === 'id' && (isTemp(p.value.name) || isObfName(p.value.name) || isParam(p.value.name))) {
          propHints.set(p.value.name, p.key);
          if (isParam(p.value.name) && !paramUsageHints.has(p.value.name)) paramUsageHints.set(p.value.name, p.key);
        }
      }
    }
    if (n.k === 'call') {
      const callee = n.fn.k === 'member' ? n.fn.prop : (n.fn.k === 'id' ? n.fn.name : null);
      if (callee && FN_PARAM_HINTS[callee]) {
        const ph = FN_PARAM_HINTS[callee];
        n.args.forEach((arg, idx) => {
          if (arg?.k === 'id' && isTemp(arg.name) && ph[idx] && !sinkHints.has(arg.name)) {
            sinkHints.set(arg.name, ph[idx]);
          }
        });
      }
      if (callee === 'resolve' || callee === 'res') {
        if (n.args[0]?.k === 'id' && isParam(n.args[0].name) && !paramUsageHints.has(n.args[0].name)) {
          paramUsageHints.set(n.args[0].name, 'result');
        }
      }
      if (n.fn.k === 'member') {
        const p = n.fn.prop;
        const a0 = n.args[0];
        if ((p === 'readFile' || p === 'readFileSync' || p === 'writeFile' || p === 'writeFileSync' || p === 'statSync' || p === 'existsSync' || p === 'unlinkSync' || p === 'basename' || p === 'extname' || p === 'dirname') && a0?.k === 'id' && isParam(a0.name)) {
          paramUsageHints.set(a0.name, 'filePath');
        }
        if ((p === 'readdir' || p === 'readdirSync' || p === 'mkdirSync') && a0?.k === 'id' && isParam(a0.name)) {
          paramUsageHints.set(a0.name, 'dirPath');
        }
        if (p === 'split' && n.fn.obj.k === 'id' && isParam(n.fn.obj.name) && !paramUsageHints.has(n.fn.obj.name)) {
          paramUsageHints.set(n.fn.obj.name, hasTokenStr.length ? 'token' : 'str');
        }
      }
    }
    if (n.k === 'member' && n.obj.k === 'id' && isParam(n.obj.name)) {
      if (n.prop === 'm_pVertexData' || n.prop === 'm_escrowBuffer') {
        paramUsageHints.set(n.obj.name, 'vertexBuffer');
      } else if (n.prop === 'fname' || n.prop === 'hash') {
        paramUsageHints.set(n.obj.name, 'fileEntry');
      } else if (n.prop === 'length' && !paramUsageHints.has(n.obj.name)) {
        paramUsageHints.set(n.obj.name, inferFnNoun(info.name) || 'items');
      } else if (n.prop !== 'length' && !paramUsageHints.has(n.obj.name)) {
        paramUsageHints.set(n.obj.name, 'options');
      }
    }
  }));
  collect(info.body);
  if (hasTokenStr.length) {
    for (const [k, v] of paramUsageHints) if (v === 'str') paramUsageHints.set(k, 'token');
  }

  const tagCallbacks = (body) => eachExprDeep(body, (o, k) => walkExpr(o[k], n => {
    if (n.k === 'call') {
      const fnName = n.fn.k === 'member' ? n.fn.prop : (n.fn.k === 'id' ? n.fn.name : '');
      const objName = n.fn.k === 'member' && n.fn.obj.k === 'id' ? n.fn.obj.name : '';
      const arg0Lit = n.args[0]?.k === 'lit' ? n.args[0].v : '';
      const lastArg = n.args[n.args.length - 1];
      if (lastArg && lastArg.k === 'fn') {
        const ps = lastArg.info.params;
        if (objName === 'ipcMain' && fnName === 'handle') {
          const chHints = {
            'pipeline-run': ['e', 'config'],
            'pipeline-connect': ['e', 'cfxLink'],
            'dumper-connect': ['e', 'cfxLink'],
            'dumper-dump': ['e', 'names'],
            'auto-connect-start': ['e', 'cfxLink', 'stage'],
            'select-file': ['e', 'defaultPath'],
            'get-files': ['e', 'dirPath'],
            'open-folder': ['e', 'dirPath'],
            'license:submit': ['e', 'key'],
          };
          lastArg.info._paramHints = chHints[arg0Lit] || ['e', 'arg'];
        } else if (fnName === 'on' || fnName === 'once') {
          const evHints = {
            log: ['d'], 'dump-stats': ['d'], stats: ['d'], resources: ['d'],
            complete: ['d'], 'pipeline-complete': ['d'], progress: ['d'],
            message: ['msg'], data: ['chunk'], exit: ['code'],
            'before-input-event': ['event', 'input'],
            uncaughtException: ['err'], unhandledRejection: ['err'],
          };
          if (evHints[arg0Lit]) lastArg.info._paramHints = evHints[arg0Lit];
        } else if (fnName === '_walkDir' && ps.length >= 1) {
          lastArg.info._paramHints = ['filePath'];
        } else if ((fnName === 'exec' || fnName === 'execFile') && ps.length >= 1) {
          lastArg.info._paramHints = ['err', 'stdout'];
        } else if (fnName === 'reduce' && ps.length === 2) {
          lastArg.info._paramHints = ['acc', 'entry'];
        } else if (fnName === 'sort' && ps.length === 2) {
          lastArg.info._paramHints = ['a', 'b'];
        } else if ((fnName === 'map' || fnName === 'filter' || fnName === 'find' || fnName === 'forEach' || fnName === 'flatMap') && ps.length === 1) {
          lastArg.info._paramHints = ['entry'];
        } else if (fnName === 'then' && ps.length === 1) {
          lastArg.info._paramHints = ['res'];
        }
      }
    }
    if (n.k === 'new' && n.fn.k === 'id' && n.fn.name === 'Promise' && n.args[0]?.k === 'fn') {
      n.args[0].info._paramHints = ['resolve', 'reject'];
    }
  }));
  tagCallbacks(info.body);

  const paramMap = new Map();
  const hints = (info.name && FN_PARAM_HINTS[info.name]) || info._paramHints || null;
  (info.params || []).forEach((p, idx) => {
    const mDef = /^([a-zA-Z_$][\w$]*)\s*=\s*(.+)$/s.exec(p);
    const rawP = mDef ? mDef[1] : p;
    const defRhs = mDef ? mDef[2] : null;
    if (!isParam(rawP) && !isObfName(rawP)) { names.add(rawP); return; }
    let cand = hints && hints[idx] ? hints[idx] : null;
    if (!cand && paramUsageHints.has(rawP)) cand = paramUsageHints.get(rawP);
    if (!cand && defRhs === '{}') cand = 'options';
    if (!cand && idx === 0 && info.name) cand = inferFnNoun(info.name);
    if (!cand && info.kind && /Ctor/.test(info.kind) && idx === 0) cand = 'opts';
    if (!cand) cand = idx === 0 ? 'arg' : 'arg' + (idx + 1);
    let finalCand = cand;
    if (names.has(finalCand) || RESERVED.has(finalCand)) {
      for (let k = 2; k <= 9; k++) {
        if (!names.has(cand + k)) { finalCand = cand + k; break; }
      }
    }
    if (finalCand && !names.has(finalCand) && !RESERVED.has(finalCand)) {
      info.params[idx] = defRhs ? `${finalCand} = ${defRhs}` : finalCand;
      paramMap.set(rawP, finalCand);
      names.add(finalCand);
    } else {
      names.add(rawP);
    }
  });

  const obfMap = new Map(outerObfMap);
  for (const p of (info.params || [])) if (!paramMap.has(p)) obfMap.delete(p);
  for (const [oldP, newP] of paramMap) obfMap.set(oldP, newP);
  const map = new Map([...obfMap, ...paramMap]);
  const counters = {};
  const allocName = (t, base) => {
    if (map.has(t)) return map.get(t);
    if (!base) base = propHints.get(t) || assignHints.get(t) || sinkHints.get(t) || (counterVars.has(t) ? 'count' : null);
    if (base && !RESERVED.has(base) && ID.test(base)) {
      if (!names.has(base)) { names.add(base); map.set(t, base); if (isObfName(t)) obfMap.set(t, base); return base; }
      for (let k = 2; k <= 15; k++) {
        const cand = base + k;
        if (!names.has(cand)) { names.add(cand); map.set(t, cand); if (isObfName(t)) obfMap.set(t, cand); return cand; }
      }
    }
    const pre = isObfName(t) ? 'v' : (t[1] || 'v');
    let n;
    do { n = (pre === 'v' ? 'v' : pre) + (counters[pre] = (counters[pre] === undefined ? 0 : counters[pre] + 1)); } while (names.has(n));
    names.add(n);
    map.set(t, n);
    if (isObfName(t)) obfMap.set(t, n);
    return n;
  };

  const fix = (body) => {
    for (const s of body) {
      if (s.t === 'fndecl') rename(s.info, names, obfMap);
      if (s.t === 'var' && s.e?.k === 'fn' && s.e.info && !s.e.info.name && !isTemp(s.name)) {
        s.e.info.name = s.name;
      }
      if (s.t === 'var' && s.destruct) {
        const isSplit = s.e && s.e.k === 'call' && s.e.fn.k === 'member' && s.e.fn.prop === 'split';
        const splitHints = s.destruct.length === 3 ? ['part1', 'part2', 'part3'] : ['part1', 'part2', 'part3', 'part4'];
        s.destruct = s.destruct.map((n, idx) => (isTemp(n) || isObfName(n)) ? allocName(n, isSplit ? splitHints[idx] : (idx === 0 ? 'k' : 'v')) : n);
        s.name = '[' + s.destruct.join(', ') + ']';
      } else if (s.t === 'var' && (isTemp(s.name) || isObfName(s.name))) {
        let hint = propHints.get(s.name) || inferExprName(s.e, map) || assignHints.get(s.name) || sinkHints.get(s.name);
        if (!hint && counterVars.has(s.name)) hint = 'count';
        if (!hint && s.e?.k === 'lit') {
          if (typeof s.e.v === 'boolean') hint = 'flag';
          else if (typeof s.e.v === 'number') hint = s.e.v === 1 ? 'attempt' : 'num';
        }
        s.name = allocName(s.name, hint || 'val');
      }
      if (s.t === 'decl') s.names = s.names.map(n => (isTemp(n) || isObfName(n)) ? allocName(n, propHints.get(n) || assignHints.get(n) || sinkHints.get(n) || 'tmp') : n);
      if (s.t === 'for') {
        if (s.init) s.init = s.init.replace(/\$[a-z]\d+/g, m => allocName(m, 'i'));
        if (s.update) s.update = s.update.replace(/\$[a-z]\d+/g, m => allocName(m, 'i'));
      }
      if (s.t === 'forin' && s.destruct) {
        const isEntries = s.e && s.e.k === 'call' && s.e.fn.k === 'member' && s.e.fn.prop === 'entries';
        s.destruct = s.destruct.map((n, idx) => (isTemp(n) || isObfName(n)) ? allocName(n, isEntries ? (idx === 0 ? 'key' : 'val') : null) : n);
        s.name = '[' + s.destruct.join(', ') + ']';
      } else if (s.t === 'forin' && (isTemp(s.name) || isObfName(s.name))) {
        const iterName = s.e?.k === 'id' ? s.e.name : (s.e?.k === 'member' ? s.e.prop : null);
        s.name = allocName(s.name, singularize(iterName));
      }
      if (s.t === 'try' && s.param && (isTemp(s.param) || isObfName(s.param))) s.param = allocName(s.param, 'err');
      for (const [o, k] of stmtExprs(s)) o[k] = mapExpr(o[k], (n) => {
        if (n.k === 'id' && (isTemp(n.name) || isObfName(n.name) || map.has(n.name))) { n.name = allocName(n.name); }
        if (n.k === 'fn') {
          rename(n.info, names, obfMap);
          if (n.info.methods) for (const m of n.info.methods) if (m.fn && m.fn.info) rename(m.fn.info, names, obfMap);
        }
        return null;
      });
      if (s.t !== 'fndecl') for (const b of childBlocks(s)) fix(b);
    }
  };
  fix(info.body);
}

function customB64Decode(str) {
  const alpha = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';
  let out = '', bc = 0, bs = 0;
  for (let i = 0; i < str.length; i++) {
    const idx = alpha.indexOf(str.charAt(i));
    if (~idx) {
      bs = bc % 4 ? bs * 64 + idx : idx;
      if (bc++ % 4) out += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6)));
    }
  }
  let uri = '';
  for (let i = 0; i < out.length; i++) uri += '%' + ('00' + out.charCodeAt(i).toString(16)).slice(-2);
  try { return decodeURIComponent(uri); } catch { return out; }
}

function deobfuscate0x(info) {
  const body = info.body;
  let arrFnIdx = -1, arrFnName = null, rawArr = null;
  for (let i = 0; i < body.length; i++) {
    const s = body[i];
    if (s.t === 'fndecl' && /^_0x/.test(s.info.name || '')) {
      const vStmt = s.info.body.find(x => x.t === 'var' && x.e && x.e.k === 'arr' && x.e.elems.length >= 10 && x.e.elems.every(el => el && el.k === 'lit' && typeof el.v === 'string'));
      if (vStmt) {
        arrFnIdx = i;
        arrFnName = s.info.name;
        rawArr = vStmt.e.elems.map(el => el.v);
        break;
      }
    }
  }
  if (!rawArr) return false;

  let decFnIdx = -1, decFnName = null, baseOffset = 0, useB64 = false;
  for (let i = 0; i < body.length; i++) {
    const s = body[i];
    if (s.t === 'fndecl' && /^_0x/.test(s.info.name || '') && i !== arrFnIdx) {
      let callsArr = false;
      eachExprDeep(s.info.body, (o, k) => walkExpr(o[k], n => {
        if (n.k === 'call' && n.fn.k === 'id' && n.fn.name === arrFnName) callsArr = true;
        if (n.k === 'lit' && typeof n.v === 'string' && n.v.startsWith('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ')) useB64 = true;
      }));
      if (callsArr) {
        decFnIdx = i;
        decFnName = s.info.name;
        const first = s.info.body[0];
        if (first && first.t === 'expr' && first.e.k === 'assign') {
          if (first.e.op === '-=' && first.e.value.k === 'lit') baseOffset = first.e.value.v;
          else if (first.e.op === '=' && first.e.value.k === 'bin' && first.e.value.op === '-' && first.e.value.r.k === 'lit') baseOffset = first.e.value.r.v;
        }
        break;
      }
    }
  }
  if (!decFnName) return false;

  const getStr = (idx) => {
    const s = rawArr[idx - baseOffset];
    if (s === undefined) return '';
    return useB64 ? customB64Decode(s) : s;
  };

  let iifeIdx = -1;
  for (let i = 0; i < body.length; i++) {
    const s = body[i];
    if (s.t === 'expr' && s.e.k === 'call' && s.e.fn.k === 'fn' && s.e.args.length === 2 && s.e.args[0].k === 'id' && s.e.args[0].name === arrFnName && s.e.args[1].k === 'lit') {
      iifeIdx = i;
      const targetSum = s.e.args[1].v;
      let sumExpr = null;
      eachExprDeep(s.e.fn.info.body, (o, k) => walkExpr(o[k], n => {
        if (n.k === 'bin' && n.op === '===' && n.r.k === 'id') sumExpr = n.l;
      }));
      if (sumExpr) {
        const evalAst = (e) => {
          if (e.k === 'lit') return e.v;
          if (e.k === 'un' && e.op === '-') return -evalAst(e.e);
          if (e.k === 'un' && e.op === '+') return +evalAst(e.e);
          if (e.k === 'bin') {
            const l = evalAst(e.l), r = evalAst(e.r);
            switch (e.op) {
              case '+': return l + r;
              case '-': return l - r;
              case '*': return l * r;
              case '/': return l / r;
            }
          }
          if (e.k === 'call' && e.fn.k === 'id' && e.fn.name === 'parseInt' && e.args[0]?.k === 'call' && e.args[0].args[0]?.k === 'lit') {
            return parseInt(getStr(e.args[0].args[0].v), 10);
          }
          return NaN;
        };
        for (let rot = 0; rot < rawArr.length; rot++) {
          const val = evalAst(sumExpr);
          if (Math.round(val) === targetSum) break;
          rawArr.push(rawArr.shift());
        }
      }
      break;
    }
  }

  const toRemove = [arrFnIdx, decFnIdx, iifeIdx].filter(x => x >= 0).sort((a, b) => b - a);
  for (const idx of toRemove) body.splice(idx, 1);

  const cleanScope = (stmts, parentAliases) => {
    const aliases = new Set(parentAliases);
    const collectAliases = (list) => {
      let changed = true;
      while (changed) {
        changed = false;
        for (let i = list.length - 1; i >= 0; i--) {
          const s = list[i];
          if (s.t === 'var' && s.e && s.e.k === 'id' && aliases.has(s.e.name)) {
            aliases.add(s.name);
            list.splice(i, 1);
            changed = true;
          } else if (s.t === 'expr' && s.e.k === 'assign' && s.e.op === '=' && s.e.target.k === 'id' && s.e.value.k === 'id' && aliases.has(s.e.value.name)) {
            aliases.add(s.e.target.name);
            list.splice(i, 1);
            changed = true;
          }
        }
      }
      for (const s of list) {
        for (const [o, k] of stmtExprs(s)) walkExpr(o[k], n => {
          if (n.k === 'fn' && n.info?.body) collectAliases(n.info.body);
        });
        for (const b of childBlocks(s)) collectAliases(b);
      }
    };
    collectAliases(stmts);

    const replaceAllDecoderCalls = (list) => {
      eachExprDeep(list, (o, k) => {
        o[k] = mapExpr(o[k], n => {
          if (n.k === 'call' && n.fn.k === 'id' && aliases.has(n.fn.name) && n.args.length === 1 && n.args[0].k === 'lit' && typeof n.args[0].v === 'number') {
            return E.lit(getStr(n.args[0].v));
          }
          if (n.k === 'fn' && n.info?.body) replaceAllDecoderCalls(n.info.body);
          return null;
        });
      });
    };
    replaceAllDecoderCalls(stmts);
    const foldIndexToMember = (list) => {
      eachExprDeep(list, (o, k) => {
        o[k] = mapExpr(o[k], n => {
          if (n.k === 'fn' && n.info?.body) foldIndexToMember(n.info.body);
          if (n.k === 'index' && n.key.k === 'lit' && typeof n.key.v === 'string' && ID.test(n.key.v)) {
            return E.member(n.obj, n.key.v);
          }
          if (n.k === 'index' && n.obj.k === 'obj' && n.key.k === 'lit' && typeof n.key.v === 'string') {
            const found = n.obj.props.find(p => !p.computed && p.key === n.key.v);
            if (found && found.value.k === 'lit') return E.lit(found.value.v);
          }
          if (n.k === 'member' && n.obj.k === 'obj' && ID.test(n.prop)) {
            const found = n.obj.props.find(p => !p.computed && p.key === n.prop);
            if (found && found.value.k === 'lit') return E.lit(found.value.v);
          }
          return null;
        });
      });
    };
    foldIndexToMember(stmts);

    const proxies = new Map();
    for (let i = 0; i < stmts.length; i++) {
      const s = stmts[i];
      const isProxyObj = (obj) => obj && obj.k === 'obj' && obj.props.length > 0 && obj.props.every(p => !p.computed && typeof p.key === 'string' && /^[A-Za-z0-9]{5}$/.test(p.key) && (p.value.k === 'lit' || p.value.k === 'fn' || (p.value.k === 'call' && p.value.fn.k === 'id' && aliases.has(p.value.fn.name))));
      if (s.t === 'var' && isProxyObj(s.e)) {
        const pmap = new Map();
        for (const p of s.e.props) {
          let val = p.value;
          if (val.k === 'call' && val.fn.k === 'id' && aliases.has(val.fn.name) && val.args[0]?.k === 'lit') val = E.lit(getStr(val.args[0].v));
          pmap.set(p.key, val);
        }
        proxies.set(s.name, { map: pmap, idx: i });
      } else if (s.t === 'expr' && s.e.k === 'assign' && s.e.op === '=' && s.e.target.k === 'id' && isProxyObj(s.e.value)) {
        const pmap = new Map();
        for (const p of s.e.value.props) {
          let val = p.value;
          if (val.k === 'call' && val.fn.k === 'id' && aliases.has(val.fn.name) && val.args[0]?.k === 'lit') val = E.lit(getStr(val.args[0].v));
          pmap.set(p.key, val);
        }
        proxies.set(s.e.target.name, { map: pmap, idx: i });
      }
    }

    if (proxies.size > 0) {
      const applyProxyBlock = (list) => {
        for (let pass = 0; pass < 3; pass++) {
          eachExprDeep(list, (o, k) => {
            o[k] = mapExpr(o[k], n => {
              if ((n.k === 'member' || (n.k === 'index' && n.key.k === 'lit')) && n.obj.k === 'id' && proxies.has(n.obj.name)) {
                const prop = n.k === 'member' ? n.prop : n.key.v;
                const val = proxies.get(n.obj.name).map.get(prop);
                if (val && val.k === 'lit') return E.lit(val.v);
              }
              if (n.k === 'call' && (n.fn.k === 'member' || (n.fn.k === 'index' && n.fn.key.k === 'lit')) && n.fn.obj.k === 'id' && proxies.has(n.fn.obj.name)) {
                const prop = n.fn.k === 'member' ? n.fn.prop : n.fn.key.v;
                const val = proxies.get(n.fn.obj.name).map.get(prop);
                if (val && val.k === 'fn' && val.info.body.length === 1 && val.info.body[0].t === 'return') {
                  const ret = val.info.body[0].e;
                  const ps = val.info.params;
                  if (ret.k === 'bin' && ret.l.k === 'id' && ret.r.k === 'id' && ps.length === 2) {
                    const a = ret.l.name === ps[0] ? n.args[0] : n.args[1];
                    const b = ret.r.name === ps[1] ? n.args[1] : n.args[0];
                    if (a && b) return E.bin(ret.op, a, b);
                  }
                  if (ret.k === 'call' && ret.fn.k === 'id' && ret.fn.name === ps[0]) {
                    return E.call(n.args[0], n.args.slice(1));
                  }
                }
              }
              return null;
            });
          });
        }
        eachExprDeep(list, (o, k) => walkExpr(o[k], n => {
          if (n.k === 'fn' && n.info?.body) applyProxyBlock(n.info.body);
        }));
      };
      applyProxyBlock(stmts);
      const idxs = [...proxies.values()].map(p => p.idx).sort((a, b) => b - a);
      for (const idx of idxs) stmts.splice(idx, 1);
    }

    const walkBlocks = (list) => {
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        if (s.t === 'fndecl') cleanScope(s.info.body, aliases);
        for (const [o, k] of stmtExprs(s)) {
          walkExpr(o[k], n => {
            if (n.k === 'fn') {
              if (n.info.methods) {
                for (const m of n.info.methods) {
                  if (m.computed && m.key && m.key.k === 'lit' && typeof m.key.v === 'number') {
                    m.key = E.lit(getStr(m.key.v));
                  }
                  if (m.computed && m.key && m.key.k === 'call' && m.key.fn.k === 'id' && aliases.has(m.key.fn.name) && m.key.args[0]?.k === 'lit') {
                    m.key = E.lit(getStr(m.key.args[0].v));
                  }
                  if (m.computed && m.key && m.key.k === 'lit' && typeof m.key.v === 'string' && ID.test(m.key.v)) {
                    m.computed = false;
                    m.key = m.key.v;
                    if (m.fn?.info) m.fn.info.name = m.key;
                  }
                  if (m.fn?.info) cleanScope(m.fn.info.body, aliases);
                }
              }
              cleanScope(n.info.body, aliases);
            }
          });
          o[k] = mapExpr(o[k], n => {
            if (n.k === 'index' && n.key.k === 'lit' && typeof n.key.v === 'string' && ID.test(n.key.v)) {
              return E.member(n.obj, n.key.v);
            }
            if ((n.k === 'member' || (n.k === 'index' && n.key.k === 'lit')) && n.obj.k === 'obj') {
              const prop = n.k === 'member' ? n.prop : n.key.v;
              const found = n.obj.props.find(p => !p.computed && p.key === prop);
              if (found && found.value.k === 'lit') return E.lit(found.value.v);
            }
            return null;
          });
        }
        for (const b of childBlocks(s)) walkBlocks(b);

        if (s.t === 'if' && s.c.k === 'bin' && (s.c.op === '===' || s.c.op === '!==' || s.c.op === '==' || s.c.op === '!=') && s.c.l.k === 'lit' && s.c.r.k === 'lit') {
          const res = s.c.op.startsWith('=') ? s.c.l.v === s.c.r.v : s.c.l.v !== s.c.r.v;
          const branch = res ? s.a : (s.b || []);
          list.splice(i, 1, ...branch);
          i--;
          continue;
        }

        if (s.t === 'var' && s.e && s.e.k === 'call' && s.e.fn.k === 'member' && s.e.fn.prop === 'split' && s.e.fn.obj.k === 'lit' && typeof s.e.fn.obj.v === 'string' && /^\d+(\|\d+)+$/.test(s.e.fn.obj.v)) {
          const order = s.e.fn.obj.v.split('|');
          const wStmt = list[i + 2];
          if (wStmt && wStmt.t === 'while' && wStmt.body.length >= 1) {
            const sw = wStmt.body.find(x => x.t === 'switch');
            if (sw) {
              const caseMap = new Map();
              for (const c of sw.cases) {
                if (c.test && c.test.k === 'lit') {
                  const cBody = c.body.filter(st => st.t !== 'break' && st.t !== 'continue');
                  caseMap.set(String(c.test.v), cBody);
                }
              }
              const flat = [];
              for (const stepKey of order) {
                if (caseMap.has(stepKey)) flat.push(...caseMap.get(stepKey));
              }
              list.splice(i, 3, ...flat);
              i--;
              continue;
            }
          }
        }
      }
    };
    walkBlocks(stmts);
  };

  cleanScope(body, new Set([decFnName]));

  for (let i = 0; i < body.length - 2; i++) {
    const s0 = body[i], s1 = body[i + 1], s2 = body[i + 2];
    if (s0.t === 'var' && s0.e?.k === 'fn' && s0.e.info.isClass && s1.t === 'var' && s1.e?.k === 'id' && s1.e.name === s0.name && s2.t === 'expr' && s2.e.k === 'assign' && s2.e.target.k === 'member' && s2.e.target.obj.k === 'id' && s2.e.target.obj.name === 'module' && s2.e.target.prop === 'exports' && s2.e.value.k === 'id' && (s2.e.value.name === s0.name || s2.e.value.name === s1.name)) {
      s2.e.value = s0.e;
      body.splice(i, 2);
      break;
    }
  }
  return true;
}

function process(info) {
  const body = info.body;
  stripWrapperPrologue(body, true);
  const nested = [];
  eachExprDeep(body, (o, k) => fnBodies(o[k], nested));
  collectFnDecls(body, nested);
  nested.forEach(process);

  for (let pass = 0; pass < 4; pass++) {
    foldShortCircuit(body);
    const c0 = new Map(), w0 = new Map();
    countIds(body, c0, w0);
    inlineBlock(body, c0, w0);
  }
  foldDecls(body);
  for (let pass = 0; pass < 4; pass++) {
    foldShortCircuit(body);
    const c2 = new Map(), w2 = new Map();
    countIds(body, c2, w2);
    inlineBlock(body, c2, w2);
  }
  if (deobfuscate0x(info)) {
    const cleanAfter0x = (fnInfo) => {
      const b = fnInfo.body;
      const fixIndex = (list) => {
        for (const st of list) for (const cb of childBlocks(st)) fixIndex(cb);
        for (let i = 0; i + 1 < list.length; i++) {
          const s0 = list[i], s1 = list[i + 1];
          if (s0.t === 'var' && isTemp(s0.name) && s0.e?.k === 'lit' && typeof s0.e.v === 'string' && ID.test(s0.e.v) &&
              s1.t === 'expr' && s1.e.k === 'assign' && s1.e.op === '=' && s1.e.target.k === 'index' && s1.e.target.key.k === 'id' && s1.e.target.key.name === s0.name &&
              s1.e.value.k === 'bin' && (s1.e.value.op === '+' || s1.e.value.op === '-') && s1.e.value.r.k === 'lit' && s1.e.value.r.v === 1 &&
              s1.e.value.l.k === 'index' && JSON.stringify(s1.e.value.l.obj) === JSON.stringify(s1.e.target.obj) && s1.e.value.l.key.k === 'id' && s1.e.value.l.key.name === s0.name) {
            list.splice(i, 2, { t: 'expr', e: { k: 'un', op: s1.e.value.op === '+' ? '++' : '--', e: E.member(s1.e.target.obj, s0.e.v), post: true }, pos: s1.pos });
            i--;
          }
        }
        eachExprDeep(list, (o, k) => {
          o[k] = mapExpr(o[k], n => {
            if (n.k === 'index' && n.key.k === 'lit' && typeof n.key.v === 'string' && ID.test(n.key.v)) return E.member(n.obj, n.key.v);
            return null;
          });
        });
      };
      for (let pass = 0; pass < 3; pass++) {
        foldShortCircuit(b);
        const cd = new Map(), wd = new Map();
        countIds(b, cd, wd);
        inlineBlock(b, cd, wd);
        fixIndex(b);
      }
      foldDecls(b);
      for (let pass = 0; pass < 3; pass++) {
        foldShortCircuit(b);
        const cd2 = new Map(), wd2 = new Map();
        countIds(b, cd2, wd2);
        inlineBlock(b, cd2, wd2);
        fixIndex(b);
      }
      foldCompoundAssign(b);
      for (let pass = 0; pass < 2; pass++) {
        const cd3 = new Map(), wd3 = new Map();
        countIds(b, cd3, wd3);
        inlineBlock(b, cd3, wd3);
      }
      recoverParams(fnInfo);
      eachExprDeep(b, (o, k) => walkExpr(o[k], n => {
        if (n.k === 'fn') {
          if (n.info) cleanAfter0x(n.info);
          if (n.info?.methods) for (const m of n.info.methods) if (m.fn?.info) cleanAfter0x(m.fn.info);
        }
      }));
    };
    cleanAfter0x(info);
  }
  {
    const c3 = new Map(), w3 = new Map();
    countIds(body, c3, w3);
    foldObjectDestruct(body, c3, w3);
  }
  dropGuards(body);
  foldCompoundAssign(body);
  shapeLoops(body);
  foldOptionalChaining(body);
  {
    const c4 = new Map(), w4 = new Map();
    countIds(body, c4, w4);
    inlineBlock(body, c4, w4);
  }
  recoverParams(info);
  applyTemplates(body);
  reorderHoistedFunctions(body);
  return info;
}
module.exports = { process, rename };
