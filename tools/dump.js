const fs = require('fs'), path = require('path');
const { load, functions, strOf, MAP } = require('../src/model');
const { mapOf } = require('../src/heap');
const { disasm } = require('../src/disasm');
const oracle = require('../src/oracle');
const [file, exe] = process.argv.slice(2);
const EXE = exe || process.env.JSC_RUNTIME || '';
const h = load(fs.readFileSync(file));
const fns = functions(h);

const refs = [];
for (const fn of fns) for (const w of fn.bc.pool.words.slice(2)) {
  if (w.t === 'ro') refs.push({ k: 'ro', a: w.chunk, b: w.off });
  if (w.t === 'root') refs.push({ k: 'root', a: w.idx });
}
const R = oracle.resolve(EXE, path.join(__dirname, '../templates/oracle-v12.8.jsc'), refs);

function desc(w) {
  if (w.t === 'raw') return 'smi:' + ((w.v | 0) >> 1);
  if (w.t === 'ro') { const r = R.get(`ro:${w.chunk}:${w.off}`); return r.type === 'string' ? JSON.stringify(r.value) : '<' + r.type + '>'; }
  if (w.t === 'root') { const r = R.get(`root:${w.idx}`); return r.type === 'string' ? JSON.stringify(r.value) : '<' + r.type + '>'; }
  if (w.t === 'obj') {
    const o = h.objs[w.id]; const m = mapOf(h, o);
    const s = strOf(h, o);
    if (s !== null) return JSON.stringify(s);
    if (m === MAP.SFI) return '<SFI#' + o.id + '>';
    return '<obj#' + o.id + ' map' + m + '>';
  }
  return '<' + w.t + '>';
}
for (const fn of fns) {
  console.log(`\n=== SFI#${fn.sfi.id}  bytecode=${fn.bc.length}B params=${fn.bc.params} regs=${fn.bc.frameSize / 8}`);
  const pool = fn.bc.pool.words.slice(2);
  pool.forEach((w, i) => console.log(`  [${i}] ${desc(w)}`));
  for (const i of disasm(fn.bc.bytes)) console.log(String(i.off).padStart(4), i.name.padEnd(28), i.ops.join(', '));
}
