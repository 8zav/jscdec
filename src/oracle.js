'use strict';
const fs = require('fs'), path = require('path'), os = require('os');
const { spawnSync } = require('child_process');

const key = (r) => r.k === 'ro' ? `ro:${r.a}:${r.b}` : `root:${r.a}`;

function run(exe, args, env) {
  const r = spawnSync(exe, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...env }, encoding: 'utf8', maxBuffer: 1 << 28 });
  return (r.stdout || '') + (r.stderr && /abort|Fatal/i.test(r.stderr) ? '\nSTDERR:' + r.stderr : '');
}

function classify(line) {
  if (/^0x[0-9a-f]+\s+<String\[\d+\]/i.test(line)) return 'string';
  if (/^0x[0-9a-f]+\s+<undefined>/i.test(line)) return 'undefined';
  if (/^0x[0-9a-f]+\s+<null>/i.test(line)) return 'null';
  if (/^0x[0-9a-f]+\s+<true>/i.test(line)) return 'true';
  if (/^0x[0-9a-f]+\s+<false>/i.test(line)) return 'false';
  if (/^0x[0-9a-f]+\s+<the_hole_value>/i.test(line)) return 'hole';
  if (/^0x[0-9a-f]+\s+<Symbol/i.test(line)) return 'symbol';
  const m = line.match(/^0x[0-9a-f]+\s+<([A-Za-z_]+)/i);
  return m ? m[1] : 'other';
}

function resolve(exe, template, refs) {
  const uniq = [...new Map(refs.map(r => [key(r), r])).values()];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jscref-'));
  const child = path.join(__dirname, 'oracle-child.js');
  const f1 = path.join(tmp, 'r1.json');
  fs.writeFileSync(f1, JSON.stringify(uniq));
  const out1 = run(exe, ['--allow-natives-syntax', child, template, f1, 'classify']);
  const res = new Map();
  const lines = out1.split(/\r?\n/);
  for (const ln of lines) {
    const m = ln.match(/^@@(\d+) (.*)$/);
    if (m) res.set(key(uniq[+m[1]]), { type: classify(m[2]), dbg: m[2] });
  }
  uniq.forEach(r => { if (!res.has(key(r))) res.set(key(r), { type: 'unknown' }); });
  const strs = uniq.filter(r => res.get(key(r)).type === 'string').map(r => ({ ...r, s: 1 }));
  if (strs.length) {
    const f2 = path.join(tmp, 'r2.json');
    fs.writeFileSync(f2, JSON.stringify(strs));
    const out2 = run(exe, [path.join(__dirname, 'oracle-child.js'), template, f2, 'string']);
    for (const ln of out2.split(/\r?\n/)) {
      const m = ln.match(/^@@(\d+) (.*)$/);
      if (m) res.get(key(strs[+m[1]])).value = JSON.parse(m[2]);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  return res;
}

module.exports = { resolve, key };
