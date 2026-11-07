# Supported V8, Electron & Node.js Versions

`jscdec` supports both **4-byte pointer-compressed** V8 snapshots (used by Electron) and **8-byte uncompressed x64** V8 snapshots (used by standard Node.js builds and Electron utility workers).

## Compatibility Matrix

| Runtime / Target | V8 Version | Pointer Size | Header / Opcode Table | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Electron 34.x** | **V8 13.2** | 4-byte (pointer compression) | `0x20` / `0xb3` (208 opcodes) | **Full support** — built-in `RO_SPACE` table |
| **Electron 33.x** | **V8 13.0** | 4-byte (pointer compression) | `0x20` / `0xaf` (204 opcodes) | **Full support** — built-in `RO_SPACE` table |
| **Electron 32.x** | **V8 12.8** | 4-byte (pointer compression) | `0x20` / `0xaf` (204 opcodes) | **Full support** — built-in `RO_SPACE` table + Oracle |
| **Electron 31.x** | **V8 12.6** | 4-byte (pointer compression) | `0x20` / `0xaf` (204 opcodes) | **Full support** — built-in `RO_SPACE` table |
| **Electron 30.x** | **V8 12.4** | 4-byte (pointer compression) | `0x20` / `0xae` (203 opcodes) | **Full support** — built-in `RO_SPACE` table |
| **Electron 29.x** | **V8 12.2** | 4-byte (pointer compression) | `0x20` / `0xab` (200 opcodes) | **Full support** — built-in `RO_SPACE` table |
| **Electron 28.x** | **V8 12.0** | 4-byte (pointer compression) | `0x20` / `0xaa` (199 opcodes) | **Full support** — built-in `RO_SPACE` table |
| **Electron 27.x** | **V8 11.8** | 4-byte (pointer compression) | `0x20` / `0xaa` (199 opcodes) | **Full support** — built-in `RO_SPACE` table |
| **Electron 25.x–26.x** | **V8 11.4–11.6** | 4-byte (pointer compression) | `0x18` / `0xaa` (199 opcodes) | **Full support** — built-in `RO_SPACE` table |
| **Electron 22.x–24.x** | **V8 10.8–11.2** | 4-byte (pointer compression) | `0x18` / `0xa9` (198 opcodes) | **Full support** — built-in `RO_SPACE` table |
| **Node.js 20.x–22.x (x64)** | **V8 11.3–12.4** | 8-byte (uncompressed x64) | `0x20` / `0xae` (203 opcodes) | **Full support** — built-in x64 `RO_SPACE` table |

## Snapshot & Bytecode Differences Handled Automatically

- **SerializedCodeData Header Layout**: Automatic detection of `0x18`-byte headers (V8 10.8–11.6) vs `0x20`-byte headers (V8 11.8–13.2).
- **Snapshot Space Tags**: Supports both 3-space and 4-space (`kReadOnlyHeap`) serializer tag encodings.
- **Frame Register Base**: Adapts between `r0 = -6` (V8 <= 11.2) and `r0 = -7` (V8 >= 11.4).
- **ScopeInfo & HashTables**: Decodes inlined context-local arrays as well as `NameToIndexHashTable` (`.map = 0x1019`) when local variable counts exceed V8's inline threshold.
- **Read-Only Space (`RO_SPACE`) Resolution**: Pre-built multi-version lookup tables in [`templates/ro-multi.json`](../templates/ro-multi.json), [`templates/ro-v12.8.json`](../templates/ro-v12.8.json), and [`templates/ro-v12.4-x64.json`](../templates/ro-v12.4-x64.json).

## Test Binaries

See [`test-jsc/`](../test-jsc/) for 33 pre-compiled `.jsc` binaries across Electron 22, 25, 27, 28, 29, 30, 31, 32, 33, 34 and Node.js 22, plus `test-electron-app.asar`.
