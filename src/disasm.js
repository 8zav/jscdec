'use strict';
const OPS = require('./opcodes.json');
const OPS_W8 = (() => {
  const out = [];
  for (const o of OPS) {
    if (o.name === 'LdaCurrentContextSlot') {
      out.push({ name: 'LdaScriptContextSlot', ops: ['kReg', 'kIdx', 'kUImm'], use: 'kWriteAccumulator' });
      out.push({ name: 'LdaImmutableScriptContextSlot', ops: ['kReg', 'kIdx', 'kUImm'], use: 'kWriteAccumulator' });
    }
    out.push({ ...o });
    if (o.name === 'LdaLookupContextSlot') out.push({ name: 'LdaLookupScriptContextSlot', ops: ['kIdx', 'kIdx', 'kUImm'], use: 'kWriteAccumulator' });
    if (o.name === 'LdaLookupContextSlotInsideTypeof') out.push({ name: 'LdaLookupScriptContextSlotInsideTypeof', ops: ['kIdx', 'kIdx', 'kUImm'], use: 'kWriteAccumulator' });
  }
  out.forEach((o, i) => (o.code = i));
  return out;
})();
const byCode = OPS;

const SCALABLE = new Set(['kReg', 'kRegOut', 'kRegList', 'kRegOutList', 'kRegPair', 'kRegOutPair', 'kRegOutTriple', 'kRegInOut', 'kIdx', 'kUImm', 'kImm', 'kRegCount', 'kNativeContextIndex']);
const SIGNED = new Set(['kImm']);
const FIXED = { kFlag8: 1, kFlag16: 2, kIntrinsicId: 1, kRuntimeId: 2 };
const REGISTERISH = new Set(['kReg', 'kRegOut', 'kRegList', 'kRegOutList', 'kRegPair', 'kRegOutPair', 'kRegOutTriple', 'kRegInOut']);

function rd(buf, p, size, signed) {
  if (size === 1) return signed ? buf.readInt8(p) : buf.readUInt8(p);
  if (size === 2) return signed ? buf.readInt16LE(p) : buf.readUInt16LE(p);
  return signed ? buf.readInt32LE(p) : buf.readUInt32LE(p);
}

function regName(op) {
  if (op <= -7) return 'r' + (-7 - op);
  if (op >= 3) return 'a' + (op - 3);
  if (op === 2) return 'this';
  if (op === 1) return '<closure>';
  if (op === 0) return '<context>';
  return '<reg' + op + '>';
}
const regCount = (ty) => ({ kRegPair: 2, kRegOutPair: 2, kRegOutTriple: 3, kRegInOut: 1, kReg: 1, kRegOut: 1 }[ty] || 0);

function disasm(bytes, w8 = false) {
  const tbl = (w8 || bytes.w8) ? OPS_W8 : byCode;
  const out = [];
  let p = 0;
  while (p < bytes.length) {
    const start = p;
    let scale = 1;
    let code = bytes[p++];
    while ((tbl[code] && (tbl[code].name === 'Wide' || tbl[code].name === 'ExtraWide'))) {
      scale = tbl[code].name === 'Wide' ? 2 : 4;
      code = bytes[p++];
    }
    const def = tbl[code];
    if (!def) throw new Error('bad opcode 0x' + code.toString(16) + ' @' + start);
    const ins = { off: start, code, name: def.name, scale, ops: [], types: def.ops, use: def.use };
    for (const ty of def.ops) {
      const size = SCALABLE.has(ty) ? scale : (FIXED[ty] || 1);
      const signed = SIGNED.has(ty) || REGISTERISH.has(ty);
      ins.ops.push(rd(bytes, p, size, signed));
      p += size;
    }
    ins.len = p - start;
    out.push(ins);
  }
  return out;
}

const isJump = (n) => /^Jump/.test(n);
const isCondJump = (n) => /^Jump(If|Loop)/.test(n) && n !== 'JumpLoop';
function jumpTarget(ins, pool) {
  if (ins.name === 'JumpLoop') return ins.off - ins.ops[0];
  if (!isJump(ins.name)) return null;
  if (/Constant$/.test(ins.name)) {
    const e = pool[ins.ops[0]];
    return e && e.kind === 'smi' ? ins.off + e.value : null;
  }
  return ins.off + ins.ops[0];
}

module.exports = { disasm, regName, jumpTarget, isJump, isCondJump, OPS, regCount };
