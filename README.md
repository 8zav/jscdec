<div align="center">
  <img src="banner.svg" alt="jscdec — V8 / Bytenode / Electron Bytecode Decompiler" width="100%">
  <br>

  <p><strong>Pure-JavaScript decompiler for V8 <code>SerializedCodeData</code> (<code>.jsc</code>) snapshots, Electron <code>.asar</code> archives, and packaged Electron <code>.exe</code> binaries.</strong></p>
  <p>Reconstructs readable JavaScript from V8 Ignition bytecode across <strong>Electron 22–34 (V8 10.8–13.2)</strong> and <strong>Node.js 20–22 x64</strong> — zero native C++ dependencies.</p>

  <p>
    <a href="https://jsc-decompiler.vercel.app"><strong>🌐 Web Decompiler</strong></a>
    ·
    <a href="doc/versions.md"><strong>🧩 Supported Versions</strong></a>
    ·
    <a href="doc/example.md"><strong>🧪 Example Output</strong></a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/Node.js-%3E%3D18-339933?logo=nodedotjs&logoColor=white" alt="Node.js >=18">
    <img src="https://img.shields.io/badge/Language-JavaScript-F7DF1E?logo=javascript&logoColor=black" alt="JavaScript">
    <img src="https://img.shields.io/badge/Electron-22--34-47848F?logo=electron&logoColor=white" alt="Electron 22-34">
    <a href="https://github.com/8zav/jscdec/stargazers"><img src="https://img.shields.io/github/stars/8zav/jscdec?style=flat&logo=github" alt="GitHub stars"></a>
    <a href="https://github.com/8zav/jscdec/network/members"><img src="https://img.shields.io/github/forks/8zav/jscdec?style=flat&logo=github" alt="GitHub forks"></a>
  </p>
</div>

---

## 🌐 Web Decompiler

Drop a `.jsc` snapshot, an Electron `.asar` archive, or a packaged Electron `.exe` binary directly into the browser at **[https://jsc-decompiler.vercel.app](https://jsc-decompiler.vercel.app)**. Everything runs 100% client-side in memory.

https://github.com/user-attachments/assets/98a98f6a-83f6-49f1-8a08-1fe047629554

## ✨ Overview

- **Multi-Version V8 Snapshot Deserializer**: Supports both 4-byte pointer-compressed heaps (`Electron 22–34` / `V8 10.8–13.2`) and 8-byte uncompressed x64 heaps (`Node.js 20–22`) out of the box using pre-built `RO_SPACE` and `Root` tables.
- **CFG & AST Reconstruction**: Lifts classes (`extends`/`super`, getters/setters, static fields), `async`/`await`, generators, `try`/`catch`/`finally`, loops (`for`, `for...of`, `for...in`, `while`), `switch`, destructuring, and template literals.
- **Dataflow Identifier Recovery & Deobfuscation**: Restores closure names from `ScopeInfo` (inline arrays & `NameToIndexHashTable`), infers stack register names through forward/backward def-use analysis, and statically resolves rotated `_0x` string-array obfuscators.
- **In-Browser `.asar` & `.exe` Unpacker**: Extracts `resources/app.asar` from NSIS / 7-Zip packaged Electron executables via WebAssembly and decompiles all embedded `.jsc` files in one pass.

## 📚 Documentation

- **[Supported Versions (`doc/versions.md`)](doc/versions.md)** — Full V8, Electron 22–34, and Node.js 20–22 compatibility matrix and snapshot layout details.
- **[Example Output (`doc/example.md`)](doc/example.md)** — Sample decompiled output and breakdown of AST, control-flow, and identifier recovery passes.

## 📦 Installation & Usage

```bash
git clone https://github.com/8zav/jscdec.git
cd jscdec
```

### Decompile a single `.jsc` file

```bash
node bin/jscdec.js path/to/file.jsc -o output.js
```

### Decompile a directory of `.jsc` files

```bash
node bin/jscdec.js path/to/build-stage -o out/
```

### Custom runtime for unindexed `RO_SPACE` constants (optional)

```bash
node bin/jscdec.js path/to/build-stage -o out/ --runtime "path/to/electron.exe"
```

## 📁 Project Structure

```text
├── bin/
│   └── jscdec.js              # CLI entry point (single file or batch directory)
├── doc/
│   ├── example.md             # Decompilation example & recovery pipeline overview
│   └── versions.md            # Supported V8 / Electron / Node.js version matrix
├── src/
│   ├── heap.js                # V8 SerializedCodeData deserializer (4-byte & 8-byte snapshots)
│   ├── model.js               # Heap object decoder (SharedFunctionInfo, ScopeInfo, BytecodeArray)
│   ├── oracle.js              # Dynamic Electron/Node RO_SPACE & Root table string resolver
│   ├── program.js             # Multi-version ConstantPool, ScopeInfo & SourcePositionTable decoder
│   ├── opcodes.json           # Base V8 Ignition bytecode opcode definitions
│   ├── disasm.js              # Multi-version Ignition disassembler (V8 10.8–13.2 opcode tables)
│   ├── decompile.js           # Symbolic execution engine & function/class builder
│   ├── decompile-ops.js       # Per-opcode symbolic state & accumulator transitions
│   ├── decompile-flow.js      # CFG structuring (loops, switch, try/catch/finally, ternary, &&/||)
│   ├── post.js                # AST optimization, _0x deobfuscator, loop shaping & dataflow renaming
│   ├── ast.js                 # JavaScript AST pretty-printer
│   └── index.js               # Public API (decompileFile)
├── templates/                 # Pre-built multi-version RO_SPACE & Root tables
├── test-jsc/                  # 33 test .jsc binaries (Electron 22–34 & Node 22) + test-electron-app.asar
└── tools/                     # Disassembly, opcode generator & bundled Electron 32 runtime
```

---

<div align="center">
  <p><strong>jscdec</strong> · V8 / Bytenode / Electron bytecode decompiler</p>
  <p><a href="https://jsc-decompiler.vercel.app">Web Decompiler</a> · <a href="doc/versions.md">Supported Versions</a> · <a href="doc/example.md">Example Output</a></p>
</div>
