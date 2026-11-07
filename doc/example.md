# Decompilation Example & Identifier Recovery

Below is an example of the JavaScript output reconstructed by `jscdec` from a stripped Bytenode `.jsc` snapshot (V8 12.8 / Electron 32).

## Reconstructed Output

```js
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

## What `jscdec` Recovers

1. **CommonJS Module Unwrapping**: Strips V8/Bytenode's `(function (exports, require, module, __filename, __dirname) { ... })` wrapper and restores top-level `require(...)` and `module.exports` declarations.
2. **Control Flow Structuring**: Lifts raw V8 Ignition basic blocks and `HandlerTable` ranges back into structured `async`/`await`, `try`/`catch`/`finally`, `switch`, `for...of`, `for...in`, `while`, and short-circuit (`&&`, `||`, `??`, `?:`) expressions.
3. **Identifier & Parameter Recovery**:
   - **Closure & Context Variables**: Extracted directly from `ScopeInfo` (`ContextLocalNames` and `NameToIndexHashTable`).
   - **Stack Registers & Parameters**: Inferred via forward/backward def-use dataflow across call return values, property reads (`a0.userId`), object shorthand properties (`{ licenseKey: a1 }`), and API sinks (`fs.readFileSync(filePath)`).
4. **Static `_0x` Deobfuscation**: Detects rotated string-array obfuscators, evaluates the decoder functions in an isolated pass, and inlines the resolved string literals and property accesses.
