# jscdec — V8 / Bytenode / Electron `.jsc` Decompiler

Pure-JavaScript decompiler for **Bytenode / V8 `SerializedCodeData` (`.jsc`)** files. Reconstructs full, readable JavaScript source code directly from V8 Ignition bytecode snapshots without requiring a custom C++ V8 build (`depot_tools` / `ninja`).

---

## Features

- **Zero native build dependencies** — runs directly on standard Node.js (`>= 18`).
- **Dual heap architecture support**:
  - **4-byte pointer-compressed V8 snapshots** (Electron 30–33 / V8 12.4–12.8).
  - **8-byte uncompressed x64 V8 snapshots** (Node.js 20–22 / V8 11.3–12.x & Electron utility workers).
- **Full AST & Control-Flow Reconstruction**:
  - CommonJS module wrapper unwrapping (`require`, `module.exports`, `exports`, `__dirname`, `__filename`).
  - Original declaration ordering via V8 `SourcePositionTable` decoding (`const ... = require(...)` at top, hoisted `function` declarations at their original source position).
  - Classes, inheritance (`extends` / `super`), static & instance methods, getters/setters.
  - `async` / `await` (automatic generator state-machine stripping), `try` / `catch` / `finally`.
  - Structured loops: `for (let i = 0; i < n; i++)` (including V8 closure-capturing lexical loops), `for (const x of ...)`, `for (const [k, v] of ...)`, `for (const k in ...)`, `while`, `switch` / `case`.
  - Short-circuit logic (`&&`, `||`, `??`), ternaries (`? :`), optional chaining (`?.`), template literals (`` `${...}` ``), object & array destructuring (`const { a, b } = ...`), and default parameters (`opts = {}`).
- **Semantic Identifier Recovery**:
  - Automatically recovers function names, class/method names, closure context variables (`ScopeInfo`), property keys, and infers local/parameter names from call targets and usage context.
- **Read-Only Space Oracle**:
  - Resolves V8 internal Read-Only (`RO_SPACE`) and Root table string/symbol references dynamically using the target Electron/Node binary (`--runtime`) or built-in snapshot tables.

---

## Supported Versions

| Runtime / Target | V8 Version | Pointer Size | Status |
| :--- | :--- | :--- | :--- |
| **Electron 32.x** *(Primary Target)* | **V8 12.8** | 4-byte (Pointer Compression) | **Full Support** (195 Ignition opcodes + Oracle) |
| **Electron 30.x – 33.x** | **V8 12.4 – 12.8** | 4-byte (Pointer Compression) | **Supported** (via `--runtime <electron.exe>` oracle + `tools/gen-opcodes.js`) |
| **Node.js 20.x – 22.x (x64)** | **V8 11.3 – 12.x** | 8-byte (Uncompressed x64) | **Supported** (8-byte snapshot deserializer + built-in RO/Root table) |

> **Note on other V8 versions (Node 18 / Electron 17–29 / Electron 34+):**
> The deserializer (`src/heap.js`), object model (`src/model.js`), and opcode table (`src/opcodes.js`) are modular. To target a different V8 minor release where opcode numbering shifted, run `node tools/gen-opcodes.js` against the target runtime binary to regenerate the opcode table.

---

## Usage

### 1. Decompile a single `.jsc` file
```bash
# Print to stdout
node bin/jscdec.js path/to/file.jsc

# Save to file
node bin/jscdec.js path/to/file.jsc -o output.js
```

### 2. Decompile an entire directory of `.jsc` files
```bash
node bin/jscdec.js path/to/build-stage -o out/
```

### 3. Automatic Electron Runtime Detection (`RO_SPACE` Oracle)
`jscdec` comes with a pre-built V8 12.8 Read-Only heap table (`templates/ro-v12.8.json`), so most Electron 32 `.jsc` files decompile instantly without needing an external binary.

When a `.jsc` file references custom/unindexed `RO_SPACE` constants, `jscdec` **automatically locates the Electron binary** in this order:
1. Explicit `--runtime <path/to/electron.exe>` CLI flag or `JSC_RUNTIME` environment variable.
2. `bin/electron.exe` or `tools/electron.exe` inside this repository.
3. Auto-discovery from the target `.jsc` directory (walks up parent folders looking for `node_modules/electron/dist/electron.exe` or the packaged Electron app `.exe` next to `icudtl.dat` / `chrome_100_percent.pak`).
4. Local `node_modules/electron/dist/electron.exe` (if installed via `npm i -D electron@32`).

```bash
# Auto-detects runtime automatically, or specify manually:
node bin/jscdec.js path/to/build-stage -o out/ --runtime "path/to/electron.exe"
```

> **Security & Verification Note on `tools/electron.exe`:**
> This repository includes the official, unmodified **Electron 32 (`electron.exe`)** binary inside `tools/electron.exe` (via Git LFS) so `jscdec` works out of the box without any extra setup.
> - **File:** `tools/electron.exe`
> - **SHA-256:** `217C7ABC77AAA868B9423FF3E6E8F40F62633CCC4121786FAC64E481AEF3429D`
> - **Verify locally (PowerShell):** `Get-FileHash tools\electron.exe -Algorithm SHA256`
>
> If you prefer not to run the bundled binary, you can delete `tools/electron.exe` and either:
> 1. Let `jscdec` auto-detect the target application's own Electron executable,
> 2. Pass your own binary via `--runtime "path/to/electron.exe"`, or
> 3. Install the official Electron package directly from npm (`npm i -D electron@32`).

---

## Example Output

```js
// Decompiled from: license-client.jsc
// Detected: V8 12.8 (Electron 32)

const os = require("os");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { machineIdSync } = require("node-machine-id");
const { app, BrowserWindow, ipcMain } = require("electron");

function licenseFilePath() {
  return path.join(app.getPath("userData"), "license.json");
}

async function callAuth(backendUrl, key, hwid, isHeartbeat = false) {
  try {
    return (await axios.post(`${backendUrl}/api/auth`, {
      licenseKey: key,
      hwid,
      hostname: os.hostname(),
      heartbeat: isHeartbeat
    }, {
      timeout: 10000
    })).data;
  } catch (err) {
    if (err.response && err.response.data) {
      return err.response.data;
    }
    return {
      ok: false,
      reason: "network_error"
    };
  }
}
```

---

## Post-Processing & AI Code Cleanup (Recommended Tip)

When V8 compiles JavaScript to `.jsc` bytecode, **comments, formatting, and non-captured local stack variable names are permanently discarded by the compiler** (unless captured by a closure or stored as object/module properties).

While `jscdec` automatically recovers ~90% of local and parameter names using heuristic type/call inference, complex functions or obfuscated files (e.g. string-array obfuscators like `_0x...`) may still retain some generic register names (`v0`, `v1`, `a0`).

**To get 100% human-grade source code:**
Pass the decompiled `.js` output to an LLM (Claude, GPT, Gemini, Cursor) with a prompt like:
> *"Clean up this decompiled V8 JavaScript file without changing any runtime behavior: rename any remaining generic variables (`v0`, `v1`, `a0`) to descriptive names based on context, inline any redundant temporary variables, and format cleanly."*

---

## Project Structure

```text
├── bin/
│   └── jscdec.js            # CLI entry point (single file or batch directory)
├── src/
│   ├── heap.js              # V8 SerializedCodeData deserializer (4-byte & 8-byte snapshots)
│   ├── model.js             # Heap object decoder (SharedFunctionInfo, ScopeInfo, BytecodeArray)
│   ├── oracle.js            # Dynamic Electron/Node RO_SPACE & Root table string resolver
│   ├── program.js           # Constant pool, ScopeInfo & SourcePositionTable decoder
│   ├── opcodes.js           # V8 12.8 Ignition bytecode opcode definitions (195 opcodes)
│   ├── disasm.js            # Ignition bytecode disassembler (Wide / ExtraWide / Jump targets)
│   ├── decompile.js         # Symbolic execution engine & function/class builder
│   ├── decompile-ops.js     # Per-opcode symbolic state & accumulator transitions
│   ├── decompile-flow.js    # CFG structuring (loops, switch, try/catch/finally, ternary, &&/||)
│   ├── post.js              # AST optimization passes, destructuring, loop shaping & variable renaming
│   ├── ast.js               # JavaScript AST pretty-printer
│   └── index.js             # Public API (decompileFile)
├── templates/
│   └── oracle-v12.8.jsc     # Template code cache for live RO_SPACE oracle resolution
└── tools/
    ├── electron.exe         # Bundled official Electron 32 runtime for RO_SPACE oracle
    ├── dump.js              # Disassembly & heap inspection utility
    └── gen-opcodes.js       # Opcode table generator for other V8 builds
```
