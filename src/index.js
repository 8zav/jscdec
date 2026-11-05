'use strict';
const fs = require('fs');
const path = require('path');
const { Program } = require('./program');
const { FnDec } = require('./decompile');
const post = require('./post');
const { block, stmt } = require('./ast');

function findRuntime(file, explicit) {
  if (explicit && fs.existsSync(explicit)) return explicit;
  if (process.env.JSC_RUNTIME && fs.existsSync(process.env.JSC_RUNTIME)) return process.env.JSC_RUNTIME;
  const localCandidates = [
    path.join(__dirname, '../bin/electron.exe'),
    path.join(__dirname, '../tools/electron.exe'),
    path.join(__dirname, '../node_modules/electron/dist/electron.exe'),
  ];
  for (const c of localCandidates) if (fs.existsSync(c)) return c;
  let dir = path.dirname(path.resolve(file));
  for (let depth = 0; depth < 5; depth++) {
    const nm = path.join(dir, 'node_modules/electron/dist/electron.exe');
    if (fs.existsSync(nm)) return nm;
    const nmApp = path.join(dir, 'resources/app/node_modules/electron/dist/electron.exe');
    if (fs.existsSync(nmApp)) return nmApp;
    if (fs.existsSync(path.join(dir, 'icudtl.dat')) || fs.existsSync(path.join(dir, 'chrome_100_percent.pak'))) {
      try {
        const exes = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.exe') && !/^unins|^elevate|^crashpad/i.test(f));
        if (exes.length) return path.join(dir, exes[0]);
      } catch {}
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '';
}

function decompileFile(file, opts = {}) {
  const buf = fs.readFileSync(file);
  const exe = findRuntime(file, opts.exe);
  const prog = new Program(buf, { exe, template: opts.template || path.join(__dirname, '../templates/oracle-v12.8.jsc') });
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
module.exports = { decompileFile, findRuntime };
