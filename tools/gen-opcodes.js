'use strict';
const fs = require('fs');
const [exe, hdr, out] = process.argv.slice(2);
const b = fs.readFileSync(exe);

const peOff = b.readUInt32LE(0x3c);
const nSec = b.readUInt16LE(peOff + 6);
const optSize = b.readUInt16LE(peOff + 20);
const secOff = peOff + 24 + optSize;
const secs = [];
for (let i = 0; i < nSec; i++) {
  const s = secOff + i * 40;
  secs.push({ vsize: b.readUInt32LE(s + 8), va: b.readUInt32LE(s + 12), rawSize: b.readUInt32LE(s + 16), raw: b.readUInt32LE(s + 20) });
}
const f2r = (f) => { const s = secs.find(s => f >= s.raw && f < s.raw + s.rawSize); return s.va + f - s.raw; };
const r2f = (r) => { const s = secs.find(s => r >= s.va && r < s.va + s.vsize); return s ? s.raw + r - s.va : -1; };

const anchor = b.indexOf(Buffer.from('Star0\0'));
let jt = -1;
for (let p = 0; p + 4 * 200 < b.length && jt < 0; p += 4) {
  if (Math.abs(p - anchor) > 0x4000) continue;
  let ok = 0;
  for (let i = 0; i < 205; i++) {
    const rva = f2r(p) + b.readInt32LE(p + i * 4);
    const tf = r2f(rva);
    if (tf < 0 || b[tf] !== 0x48 || b[tf + 1] !== 0x8d || b[tf + 2] !== 0x05) break;
    ok++;
  }
  if (ok >= 200) jt = p;
}
if (jt < 0) throw new Error('jump table not found');
const names = [];
for (let i = 0; i < 256; i++) {
  const rva = f2r(jt) + b.readInt32LE(jt + i * 4);
  const tf = r2f(rva);
  if (tf < 0 || b[tf] !== 0x48 || b[tf + 1] !== 0x8d || b[tf + 2] !== 0x05) break;
  const sf = r2f(rva + 7 + b.readInt32LE(tf + 3));
  const nm = b.subarray(sf, b.indexOf(0, sf)).toString('ascii');
  names.push(nm);
  if (nm === 'Illegal') break;
}

const text = fs.readFileSync(hdr, 'utf8').replace(/\\\r?\n/g, ' ');
const defs = {}, uses = {};
const re = /\bV\((\w+),\s*ImplicitRegisterUse::(\w+)((?:,\s*OperandType::\w+)*)\)/g;
let m;
while ((m = re.exec(text))) {
  defs[m[1]] = [...m[3].matchAll(/OperandType::(\w+)/g)].map(x => x[1]); uses[m[1]] = m[2];
}
const table = names.map((n, i) => ({ code: i, name: n, ops: defs[n] || [], use: uses[n] || 'kNone' }));
const missing = table.filter(t => !(t.name in defs) && !/^(Star\d+|Wide|ExtraWide|Illegal)$/.test(t.name));
if (missing.length) console.warn('no operand info for:', missing.map(t => t.name).join(', '));
fs.mkdirSync(require('path').dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(table, null, 1));
console.log('opcodes:', table.length, '->', out);

