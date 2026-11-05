'use strict';
const fs = require('fs'), vm = require('vm');
const [tpl, mode] = process.argv.slice(2);
const refs = JSON.parse(fs.readFileSync(0, 'utf8'));
const dummy = new vm.Script('x').createCachedData();
const base = Buffer.from(fs.readFileSync(tpl));
dummy.copy(base, 4, 4, 8);
dummy.copy(base, 12, 12, 16);
base.set([0x85, 0x01, 0x00, 0x02, 0xaf], 0x66e);

function probe(r) {
  const jsc = Buffer.from(base);
  if (r.k === 'ro') {
    jsc.set([0x13, 4, 0xaf], 0x44b);
    const v = (r.b << 2) | 2;
    jsc.set([0x05, r.a << 2, v & 255, (v >>> 8) & 255, (v >>> 16) & 255], 0x20b);
  } else {
    jsc.set([0x13, 8, 0xaf], 0x44b);
    const v = (r.a << 2) | 1;
    jsc.set([0x07, v & 255, (v >>> 8) & 255], 0x24e);
  }
  const len = jsc.readUInt32LE(8);
  const src = ('//' + r.k + r.a + '_' + (r.b || 0) + ' '.repeat(len)).slice(0, len);
  return new vm.Script(src, { cachedData: jsc }).runInThisContext()()();
}

refs.forEach((r, i) => {
  const v = probe(r);
  if (mode === 'classify') { process.stdout.write('@@' + i + ' '); eval('%DebugPrint(v)'); }
  else if (r.s) process.stdout.write('@@' + i + ' ' + JSON.stringify(String(v)) + '\n');
});
