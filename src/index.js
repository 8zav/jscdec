'use strict';
const fs = require('fs');
const path = require('path');
const { Program } = require('./program');
const { FnDec } = require('./decompile');
const post = require('./post');
const { block, stmt } = require('./ast');

const DEFAULT_EXE = process.env.JSC_RUNTIME || '';

function decompileFile(file, opts = {}) {
  const buf = fs.readFileSync(file);
  const prog = new Program(buf, { exe: opts.exe || DEFAULT_EXE, template: opts.template || path.join(__dirname, '../templates/oracle-v12.8.jsc') });
  const top = prog.sfi(prog.h.objs[0]);
  let target = top;
  const topPool = top.bc && top.bc.pool;
  if (topPool) {
    const first = prog.poolVal(top.bc, 0);
    if (first.kind === 'sfi') target = prog.sfi(first.obj);
  }
  const chain = [];
  const dec = new FnDec(prog, target, chain, { moduleWrapper: true });
  const info = dec.run();
  post.process(info);
  post.rename(info);
  const v8ver = prog.h.W === 8 ? 'V8 12.x (x64)' : 'V8 12.8 (Electron 32)';
  const header = opts.noHeader ? '' : `// Decompiled from: ${path.basename(file)}\n// Detected: ${v8ver}\n\n`;
  return header + info.body.map(s => stmt(s, '')).filter(x => x !== null).join('\n') + '\n';
}
module.exports = { decompileFile };
