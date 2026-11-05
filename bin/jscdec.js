#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const { decompileFile } = require('../src/index');
const args = process.argv.slice(2);
if (!args.length) { console.error('usage: jscdec <file.jsc|dir> [-o out] [--runtime <electron.exe>]'); process.exit(1); }
const opt = {}; let out = null; const files = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '-o') out = args[++i];
  else if (args[i] === '--runtime') opt.exe = args[++i];
  else files.push(args[i]);
}
const list = [];
for (const f of files) {
  if (fs.statSync(f).isDirectory()) for (const x of fs.readdirSync(f)) { if (x.endsWith('.jsc')) list.push(path.join(f, x)); }
  else list.push(f);
}
for (const f of list) {
  try {
    const js = decompileFile(f, opt);
    const o = out ? (list.length > 1 ? path.join(out, path.basename(f, '.jsc') + '.js') : out) : null;
    if (o) { fs.mkdirSync(path.dirname(o), { recursive: true }); fs.writeFileSync(o, js); console.error('ok  ', f, '->', o); }
    else process.stdout.write(js);
  } catch (e) { console.error('FAIL', f, e.stack.split('\n').slice(0, 4).join('\n')); }
}
