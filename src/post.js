'use strict';
const { E, ID } = require('./ast');

const EFFECT = new Set(['call', 'new', 'assign', 'await', 'yield']);
const isTemp = (n) => typeof n === 'string' && n[0] === '$';
const isParam = (n) => typeof n === 'string' && /^a\d+$/.test(n);
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
    d.names = d.names.filter(n => !(list.some(x => x.t === 'var' && x.name === n && list.indexOf(x) > i)) || (d._keep && d._keep.has(n)));
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
    if (s.t === 'if' && !s.b && s.a.every(x => x.t === 'expr' && x.e.k === 'call' && x.e.fn.k === 'id' && /^%Runtime160$/.test(x.e.fn.name))) list.splice(i, 1);
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
      const pName = (info.name && FN_PARAM_HINTS[info.name]?.[idx]) || (info.kind && /Ctor/.test(info.kind) && idx === 0 ? 'opts' : s.e.c.l.name);
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

function inferExprName(e) {
  if (!e || typeof e !== 'object') return null;
  if (e.k === 'await') return inferExprName(e.e);
  if (e.k === 'call') {
    if (e.fn.k === 'id') {
      if (e.fn.name === 'require' && e.args[0]?.k === 'lit') return cleanIdent(e.args[0].v);
      if (e.fn.name === 'checkHWID') return 'authResult';
      if (e.fn.name === 'fetchUpdateInfo') return 'updateInfo';
      if (e.fn.name === 'loadStoredKey') return 'key';
      if (e.fn.name === 'machineIdSync') return 'hwid';
      if (e.fn.name === 'listProcessNames') return 'procs';
      if (e.fn.name === 'countModels') return 'counts';
    }
    if (e.fn.k === 'member') {
      const p = e.fn.prop;
      const objName = e.fn.obj.k === 'id' ? e.fn.obj.name : '';
      if (p === 'readdirSync') return 'entries';
      if (p === 'statSync') return 'stat';
      if (p === 'readFileSync') return 'data';
      if (p === 'createWriteStream') return 'stream';
      if (p === 'join') return 'fullPath';
      if (p === 'dirname') return 'dir';
      if (p === 'basename') return 'base';
      if (p === 'extname') return 'ext';
      if (p === 'relative') return 'relPath';
      if (p === 'now' && objName === 'Date') return 'startTime';
      if (p === 'entries' && objName === 'Object') return 'entries';
      if (p === 'all' && objName === 'Promise') return 'results';
      if (p === 'get' || p === 'post') return 'res';
      if (p === 'match') return 'match';
      if (p === 'split') return 'parts';
      if (p === 'find') return 'found';
      if (p === 'filter') return 'filtered';
      if (p === 'map') return 'mapped';
      if (p === 'slice' || p === 'subarray') return 'slice';
      if (p === 'from' && objName === 'Buffer') return 'buf';
      if (p === 'alloc' && objName === 'Buffer') return 'buf';
      if (p === 'getConfiguration') return 'resources';
      if (p === 'fetchEngine') return 'engineDir';
      if (p === 'getStoredKey') return 'licenseKey';
      if (p === 'callAuth') return 'res';
    }
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
  }
  if (e.k === 'member' && ID.test(e.prop)) {
    const p = e.prop.replace(/^m_(?:p|dw|w|b)?/, '');
    const c = p ? p[0].toLowerCase() + p.slice(1) : e.prop;
    if (ID.test(c) && !RESERVED.has(c) && c.length > 1) return c;
  }
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
};

function rename(info, usedOuter = new Set()) {
  const names = new Set(usedOuter);
  const propHints = new Map();
  const collect = (body) => eachExprDeep(body, (o, k) => walkExpr(o[k], n => {
    if (n.k === 'id' && !isTemp(n.name) && !isParam(n.name)) names.add(n.name);
    if (n.k === 'obj') {
      for (const p of n.props) {
        if (!p.computed && typeof p.key === 'string' && ID.test(p.key) && p.value?.k === 'id' && isTemp(p.value.name)) {
          propHints.set(p.value.name, p.key);
        }
      }
    }
  }));
  collect(info.body);

  const paramMap = new Map();
  const hints = (info.name && FN_PARAM_HINTS[info.name]) || null;
  (info.params || []).forEach((p, idx) => {
    if (!isParam(p)) { names.add(p); return; }
    let cand = hints && hints[idx] ? hints[idx] : null;
    if (!cand && info.kind && /Ctor/.test(info.kind) && idx === 0) cand = 'opts';
    if (cand && !names.has(cand) && !RESERVED.has(cand)) {
      info.params[idx] = cand;
      paramMap.set(p, cand);
      names.add(cand);
    } else {
      names.add(p);
    }
  });

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
        } else if ((fnName === 'exec' || fnName === 'execFile') && ps.length === 2) {
          lastArg.info._paramHints = ['err', 'stdout'];
        } else if (fnName === 'reduce' && ps.length === 2) {
          lastArg.info._paramHints = ['acc', 'item'];
        } else if (fnName === 'sort' && ps.length === 2) {
          lastArg.info._paramHints = ['a', 'b'];
        } else if ((fnName === 'map' || fnName === 'filter' || fnName === 'find' || fnName === 'forEach') && ps.length === 1) {
          lastArg.info._paramHints = ['item'];
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
  if (info._paramHints) {
    info.params.forEach((p, idx) => {
      if (isParam(p) && info._paramHints[idx] && !names.has(info._paramHints[idx])) {
        info.params[idx] = info._paramHints[idx];
        paramMap.set(p, info._paramHints[idx]);
        names.add(info._paramHints[idx]);
      }
    });
  }

  const map = new Map(paramMap);
  const counters = {};
  const allocName = (t, base) => {
    if (map.has(t)) return map.get(t);
    if (base && !RESERVED.has(base) && ID.test(base)) {
      if (!names.has(base)) { names.add(base); map.set(t, base); return base; }
      for (let k = 2; k <= 9; k++) {
        const cand = base + k;
        if (!names.has(cand)) { names.add(cand); map.set(t, cand); return cand; }
      }
    }
    const pre = t[1] || 'v';
    let n;
    do { n = (pre === 'v' ? 'v' : pre) + (counters[pre] = (counters[pre] === undefined ? 0 : counters[pre] + 1)); } while (names.has(n));
    names.add(n);
    map.set(t, n);
    return n;
  };

  const fix = (body) => {
    for (const s of body) {
      if (s.t === 'fndecl') rename(s.info, names);
      if (s.t === 'var' && s.destruct) {
        s.destruct = s.destruct.map((n, idx) => isTemp(n) ? allocName(n, idx === 0 ? 'k' : 'v') : n);
        s.name = '[' + s.destruct.join(', ') + ']';
      } else if (s.t === 'var' && isTemp(s.name)) {
        const hint = propHints.get(s.name) || inferExprName(s.e);
        s.name = allocName(s.name, hint);
      }
      if (s.t === 'decl') s.names = s.names.map(n => isTemp(n) ? allocName(n, propHints.get(n)) : n);
      if (s.t === 'for') {
        if (s.init) s.init = s.init.replace(/\$[a-z]\d+/g, m => allocName(m, 'i'));
        if (s.update) s.update = s.update.replace(/\$[a-z]\d+/g, m => allocName(m, 'i'));
      }
      if (s.t === 'forin' && s.destruct) {
        const isEntries = s.e && s.e.k === 'call' && s.e.fn.k === 'member' && s.e.fn.prop === 'entries';
        s.destruct = s.destruct.map((n, idx) => isTemp(n) ? allocName(n, isEntries ? (idx === 0 ? 'key' : 'val') : null) : n);
        s.name = '[' + s.destruct.join(', ') + ']';
      } else if (s.t === 'forin' && isTemp(s.name)) {
        const iterName = s.e?.k === 'id' ? s.e.name : (s.e?.k === 'member' ? s.e.prop : null);
        s.name = allocName(s.name, singularize(iterName));
      }
      for (const [o, k] of stmtExprs(s)) o[k] = mapExpr(o[k], (n) => {
        if (n.k === 'id' && (isTemp(n.name) || paramMap.has(n.name))) { n.name = allocName(n.name); }
        if (n.k === 'fn') {
          rename(n.info, names);
          if (n.info.methods) for (const m of n.info.methods) if (m.fn && m.fn.info) rename(m.fn.info, names);
        }
        return null;
      });
      if (s.t !== 'fndecl') for (const b of childBlocks(s)) fix(b);
    }
  };
  fix(info.body);
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
  {
    const c3 = new Map(), w3 = new Map();
    countIds(body, c3, w3);
    foldObjectDestruct(body, c3, w3);
  }
  dropGuards(body);
  foldCompoundAssign(body);
  shapeLoops(body);
  foldOptionalChaining(body);
  recoverParams(info);
  applyTemplates(body);
  reorderHoistedFunctions(body);
  return info;
}
module.exports = { process, rename };
