'use strict';
const PREC = { ',': 1, '=': 2, '?:': 3, '??': 4, '||': 4, '&&': 5, '|': 6, '^': 7, '&': 8, '==': 9, '!=': 9, '===': 9, '!==': 9,
  '<': 10, '>': 10, '<=': 10, '>=': 10, 'instanceof': 10, 'in': 10, '<<': 11, '>>': 11, '>>>': 11, '+': 12, '-': 12, '*': 13, '/': 13, '%': 13, '**': 14 };
const ID = /^[A-Za-z_$][\w$]*$/;
const RESERVED = new Set('break case catch class const continue debugger default delete do else enum export extends false finally for function if import in instanceof new null return super switch this throw true try typeof var void while with yield let static await'.split(' '));

const E = {
  lit: (v) => ({ k: 'lit', v }),
  id: (name) => ({ k: 'id', name }),
  undef: () => ({ k: 'undef' }),
  hole: () => ({ k: 'hole' }),
  member: (obj, prop) => ({ k: 'member', obj, prop }),
  index: (obj, key) => ({ k: 'index', obj, key }),
  call: (fn, args, recv) => ({ k: 'call', fn, args, recv }),
  new_: (fn, args) => ({ k: 'new', fn, args }),
  bin: (op, l, r) => ({ k: 'bin', op, l, r }),
  logic: (op, l, r) => ({ k: 'logic', op, l, r }),
  un: (op, e) => ({ k: 'un', op, e }),
  cond: (c, a, b) => ({ k: 'cond', c, a, b }),
  assign: (target, value, op) => ({ k: 'assign', target, value, op: op || '=' }),
  obj: (props) => ({ k: 'obj', props }),
  arr: (elems) => ({ k: 'arr', elems }),
  fn: (info) => ({ k: 'fn', info }),
  tostr: (e) => ({ k: 'tostr', e }),
  spread: (e) => ({ k: 'spread', e }),
  raw: (text) => ({ k: 'raw', text }),
  regexp: (pattern, flags) => ({ k: 'regexp', pattern, flags }),
  await_: (e) => ({ k: 'await', e }),
  yield_: (e, delegate) => ({ k: 'yield', e, delegate }),
};

const q = (s) => JSON.stringify(String(s)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const propKey = (k) => (typeof k === 'string' && ID.test(k) ? k : (typeof k === 'number' ? String(k) : q(k)));

function prec(e) {
  switch (e.k) {
    case 'bin': case 'logic': return PREC[e.op] || 10;
    case 'cond': return 3;
    case 'assign': return 2;
    case 'un': case 'await': case 'yield': return 15;
    case 'fn': return e.info && e.info.arrow ? 2 : 20;
    case 'new': return e.args ? 19 : 18;
    case 'tostr': return 20;
    default: return 20;
  }
}
const paren = (e, min) => (prec(e) < min ? '(' + expr(e) + ')' : expr(e));

function expr(e, ind = '') {
  switch (e.k) {
    case 'lit': {
      const v = e.v;
      if (typeof v === 'string') return q(v);
      if (typeof v === 'number') return Object.is(v, -0) ? '-0' : String(v);
      return String(v);
    }
    case 'id': return e.name;
    case 'undef': return 'undefined';
    case 'hole': return '/*hole*/undefined';
    case 'raw': return e.text;
    case 'regexp': return '/' + e.pattern + '/' + e.flags;
    case 'member': return paren(e.obj, 19) + (e.opt ? '?.' : (ID.test(e.prop) ? '.' : '')) + (ID.test(e.prop) ? e.prop : '[' + q(e.prop) + ']');
    case 'index': return paren(e.obj, 19) + (e.opt ? '?.' : '') + '[' + expr(e.key, ind) + ']';
    case 'call': return callee(e, ind) + (e.opt ? '?.' : '') + '(' + e.args.map(a => expr(a, ind)).join(', ') + ')';
    case 'new': return 'new ' + paren(e.fn, 19) + '(' + e.args.map(a => expr(a, ind)).join(', ') + ')';
    case 'bin': case 'logic': {
      const p = PREC[e.op] || 10;
      const left = e.op === '**' ? paren(e.l, p + 1) : paren(e.l, p);
      const assoc = (e.op === '&&' || e.op === '||') && e.r.k === 'logic' && e.r.op === e.op;
      const right = e.op === '**' || assoc ? paren(e.r, p) : paren(e.r, p + 1);
      return left + ' ' + e.op + ' ' + right;
    }
    case 'un': return e.post ? paren(e.e, 16) + e.op : (e.op.length > 1 && /[a-z]/.test(e.op) ? e.op + ' ' : e.op) + paren(e.e, 15);
    case 'cond': return paren(e.c, 4) + ' ? ' + paren(e.a, 2) + ' : ' + paren(e.b, 2);
    case 'assign': return expr(e.target, ind) + ' ' + e.op + ' ' + paren(e.value, 2);
    case 'await': return 'await ' + paren(e.e, 15);
    case 'yield': return 'yield' + (e.delegate ? '*' : '') + (e.e ? ' ' + paren(e.e, 2) : '');
    case 'spread': return '...' + paren(e.e, 2);
    case 'tostr': return 'String(' + expr(e.e, ind) + ')';
    case 'tmpl': return '`' + e.parts.map(p => (typeof p === 'string' ? p.replace(/[`\\]|\$\{/g, '\\$&').replace(/\r/g, '\\r').replace(/\n/g, '\\n') : '${' + expr(p, ind) + '}')).join('') + '`';
    case 'arr': return '[' + e.elems.map(x => (x ? expr(x, ind) : '')).join(', ') + ']';
    case 'obj': {
      if (!e.props.length) return '{}';
      const i2 = ind + '  ';
      return '{\n' + e.props.map(p => i2 + prop(p, i2)).join(',\n') + '\n' + ind + '}';
    }
    case 'fn': return fnExpr(e.info, ind);
    default: return '/*?' + e.k + '*/';
  }
}
function callee(e, ind) {
  const f = e.fn;
  if (f.k === 'member' || f.k === 'index') {
    return expr(f, ind);
  }
  if (f.k === 'fn') return '(' + expr(f, ind) + ')';
  return paren(f, 19);
}
function prop(p, ind) {
  if (p.kind === 'spread') return '...' + expr(p.value, ind);
  if (!p.value) return (p.computed ? '[' + expr(p.key, ind) + ']' : propKey(p.key)) + ': undefined /* unresolved */';
  const k = p.computed ? '[' + expr(p.key, ind) + ']' : propKey(p.key);
  if (p.kind === 'get' || p.kind === 'set') return p.kind + ' ' + k + fnTail(p.value.info, ind);
  if (p.value.k === 'fn' && p.value.info.method) return (p.value.info.async ? 'async ' : '') + (p.value.info.generator ? '*' : '') + k + fnTail(p.value.info, ind);
  if (p.value.k === 'id' && !p.computed && p.key === p.value.name) return k;
  return k + ': ' + paren(p.value, 2).replace(/^/, '');
}
function fnTail(info, ind) {
  const params = info.params.join(', ');
  return '(' + params + ') ' + block(info.body, ind);
}
function fnExpr(info, ind) {
  const pre = info.async ? 'async ' : '';
  if (info.arrow) {
    const ps = info.params.length === 1 && ID.test(info.params[0]) ? info.params[0] : '(' + info.params.join(', ') + ')';
    const b = info.body;
    if (b.length === 1 && b[0].t === 'return' && b[0].e && b[0].e.k !== 'obj') return pre + ps + ' => ' + paren(b[0].e, 3);
    return pre + ps + ' => ' + block(b, ind);
  }
  if (info.isClass) return classExpr(info, ind);
  return pre + 'function' + (info.generator ? '*' : '') + (info.name ? ' ' + info.name : '') + '(' + info.params.join(', ') + ') ' + block(info.body, ind);
}
function classExpr(info, ind) {
  const i2 = ind + '  ';
  const ext = info.superClass ? ' extends ' + expr(info.superClass, ind) : '';
  const lines = [];
  if (info.body && info.body.length) {
    lines.push(i2 + 'constructor(' + info.params.join(', ') + ') ' + block(info.body, i2));
  }
  for (const m of info.methods || []) {
    const fn = m.fn.info;
    const st = m.static ? 'static ' : '';
    const as = fn.async ? 'async ' : '';
    const gn = fn.generator ? '*' : '';
    const gs = fn.kind && /Getter/.test(fn.kind) ? 'get ' : fn.kind && /Setter/.test(fn.kind) ? 'set ' : '';
    const k = m.computed ? '[' + expr(m.key, i2) + ']' : propKey(m.key);
    lines.push(i2 + st + gs + as + gn + k + '(' + fn.params.join(', ') + ') ' + block(fn.body, i2));
  }
  return 'class' + (info.name ? ' ' + info.name : '') + ext + ' {\n' + lines.join('\n') + '\n' + ind + '}';
}

function block(stmts, ind = '') {
  if (!stmts.length) return '{}';
  const i2 = ind + '  ';
  return '{\n' + stmts.map(s => stmt(s, i2)).filter(x => x !== null).join('\n') + '\n' + ind + '}';
}
function stmt(s, ind) {
  const e = (x) => expr(x, ind);
  switch (s.t) {
    case 'expr': return ind + e(s.e) + ';';
    case 'var':
      if (s.e && s.e.k === 'fn' && s.e.info.isClass && (!s.e.info.name || s.e.info.name === s.name) && ID.test(s.name)) {
        s.e.info.name = s.name;
        return ind + classExpr(s.e.info, ind);
      }
      return ind + s.kind + ' ' + s.name + (s.e ? ' = ' + paren(s.e, 2).replace(/^/, '') : '') + ';';
    case 'decl': return ind + s.kind + ' ' + s.names.join(', ') + ';';
    case 'fndecl': return ind + (s.info.async ? 'async ' : '') + 'function' + (s.info.generator ? '*' : '') + ' ' + s.info.name + '(' + s.info.params.join(', ') + ') ' + block(s.info.body, ind);
    case 'return': return ind + (s.e ? 'return ' + e(s.e) : 'return') + ';';
    case 'throw': return ind + 'throw ' + e(s.e) + ';';
    case 'break': return ind + (s.label ? 'break ' + s.label : 'break') + ';';
    case 'continue': return ind + (s.label ? 'continue ' + s.label : 'continue') + ';';
    case 'if': {
      let out = ind + 'if (' + e(s.c) + ') ' + block(s.a, ind);
      if (s.b && s.b.length) {
        if (s.b.length === 1 && s.b[0].t === 'if') out += ' else ' + stmt(s.b[0], ind).trimStart();
        else out += ' else ' + block(s.b, ind);
      }
      return out;
    }
    case 'while': return ind + (s.label ? s.label + ': ' : '') + 'while (' + e(s.c) + ') ' + block(s.body, ind);
    case 'dowhile': return ind + (s.label ? s.label + ': ' : '') + 'do ' + block(s.body, ind) + ' while (' + e(s.c) + ');';
    case 'for': return ind + (s.label ? s.label + ': ' : '') + 'for (' + (s.init || '') + '; ' + (s.c ? e(s.c) : '') + '; ' + (s.update || '') + ') ' + block(s.body, ind);
    case 'forin': return ind + (s.label ? s.label + ': ' : '') + 'for (' + s.decl + ' ' + s.name + ' ' + (s.of ? 'of' : 'in') + ' ' + e(s.e) + ') ' + block(s.body, ind);
    case 'try': {
      let o = ind + 'try ' + block(s.body, ind);
      if (s.catchBody) o += ' catch' + (s.param ? ' (' + s.param + ')' : '') + ' ' + block(s.catchBody, ind);
      if (s.finallyBody) o += ' finally ' + block(s.finallyBody, ind);
      return o;
    }
    case 'switch': {
      const i2 = ind + '  ';
      return ind + 'switch (' + e(s.d) + ') {\n' + s.cases.map(c => i2 + (c.test ? 'case ' + e(c.test) : 'default') + ':\n' + c.body.map(b => stmt(b, i2 + '  ')).join('\n')).join('\n') + '\n' + ind + '}';
    }
    case 'comment': return ind + '/* ' + s.text + ' */';
    case 'label': return ind + s.name + ':';
    case 'goto': return ind + '/* goto ' + s.name + ' */';
    case 'empty': return null;
    default: return ind + '/* ?stmt ' + s.t + ' */';
  }
}
module.exports = { E, expr, stmt, block, prec, ID, PREC, q };
