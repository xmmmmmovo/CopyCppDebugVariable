# Copy Cpp Debug Variable

A VS Code extension that recursively expands a C/C++ debug variable (or Watch expression) and copies the result as JSON to the clipboard, or saves it to a file.

It talks directly to the active Debug Adapter via the [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/) (DAP), so it works with any C/C++ adapter that exposes a `variablesReference` — `cppdbg`, `lldb-vscode`, `clangd`, and friends. It does not depend on the DOM of the Variables view.

---

## Features

- **Copy / Save from the Variables & Watch context menu** — right-click any node in the Run and Debug view to copy or save it as JSON. No expression needed; the menu passes the node directly.
- **Copy / Save via a command** — `Copy Debug Variable as JSON` and `Save Debug Variable as JSON` prompt for a Watch expression (`person`, `vec[0]`, `myObject.field`, …) and read the variable tree.
- **Recursive expansion** — follows `variablesReference` to descend into structs, classes, arrays, pointers, and STL containers.
- **String-aware leaf handling** — `std::string`, `std::u8string`, `std::wstring`, `std::u16string`, `std::u32string`, `std::string_view`, `std::pmr::*`, ABI-tagged `std::__cxx11::basic_string<…>` / `std::__1::basic_string<…>`, `const char *`, `char[N]`, `wchar_t *`, `std::byte[N]` / `std::byte *` (e.g. PMR back-buffer), etc. are treated as leaves: their full UTF-8 / UTF-16 text is reconstructed from char children when the adapter exposes them, otherwise the adapter's display value is kept (no internal buffer / `[size]` / `[capacity]` / `[allocator]` leakage).
- **Safety limits** — `maxDepth`, `maxVariables`, `maxArrayItems`, and `variablePagingSize` cap recursion so a misclick never freezes the host.
- **Multi-session support** — the context-menu path resolves the correct `DebugSession` from the `sessionId` passed by VS Code, so concurrent debug sessions don't cross-talk.
- **Result document** — output JSON wraps the variable tree with `schemaVersion`, `source` (`variables` / `watch`), `expression`, `sessionType`, `capturedAt`, `warnings`, `truncated`, and `nodeCount` metadata.

---

## Commands

| Command ID                                     | Title                       | Entry point                                                      |
| ---------------------------------------------- | --------------------------- | ---------------------------------------------------------------- |
| `copy-cpp-debug-variable.copyAsJson`         | Copy Debug Variable as JSON | Command Palette — prompts for an expression                     |
| `copy-cpp-debug-variable.saveAsJson`         | Save Debug Variable as JSON | Command Palette — prompts for an expression, then a save dialog |
| `copy-cpp-debug-variable.copySelectedAsJson` | Copy as JSON                | Right-click menu in**Variables** and **Watch**       |
| `copy-cpp-debug-variable.saveSelectedAsJson` | Save as JSON                | Right-click menu in**Variables** and **Watch**       |

The two menu commands are intentionally hidden from the Command Palette (`menus.commandPalette` → `when: false`) — without a context argument they fall back to the input-box flow, and exposing both entry points would be redundant.

---

## Requirements

- VS Code `^1.125.0` (see `engines.vscode` in [package.json](package.json)).
- A C/C++ debug adapter that supports the standard DAP requests (`evaluate`, `variables`). The extension is adapter-agnostic; `cppdbg` is the primary target.

---

## Extension Settings

This extension contributes the following settings (under `copy-cpp-debug-variable.*`):

| Setting                | Default   | Min               | Description                                       |
| ---------------------- | --------- | ----------------- | ------------------------------------------------- |
| `maxDepth`           | `8`     | `1`             | Maximum recursion depth when expanding variables. |
| `maxVariables`       | `10000` | `1`             | Maximum total number of variable nodes to read.   |
| `maxArrayItems`      | `1000`  | `1`             | Maximum array / vector elements to enumerate.     |
| `variablePagingSize` | `100`   | `1` — `1000` | Page size for DAP`variables` requests.          |

---

## Usage

### 1. From the Variables / Watch context menu (recommended)

1. Start a debug session and pause at a breakpoint.
2. In the **Variables** or **Watch** view, right-click any variable.
3. Choose **Copy as JSON** or **Save as JSON**.
4. The result lands in the clipboard (or a file you pick). A status bar message reports the node count.

### 2. From the Command Palette

1. Start a debug session and pause at a breakpoint.
2. Open the Command Palette and run **Copy Debug Variable as JSON** (or **Save Debug Variable as JSON**).
3. Type a C/C++ expression — for example `people`, `people[0].address`, `company.employees`, `linked->next`.
4. The result is copied to the clipboard (or saved to a file you pick).

---

## Try it locally

A runnable C++23 sample lives in [demo/](demo/README.md). Build it with CMake, drop a breakpoint after `people` is initialised, and exercise the commands against the suggested expressions (`people`, `people[0]`, `people[0].address`, `people[0].scores`, `company`, `company.employees`, `linked`, `linked->next`).

---

## Known Issues

- Some adapters do not expose `variablesReference` for primitive locals. In that case the leaf `value` is still captured, but no children will be fetched.
- Adapters that do not surface individual `char` children for string-like types will fall back to the adapter's display value rather than a reconstructed text.
- Expressions that depend on registers or hardware state may be rejected by the adapter; failures surface as a notification and a `warnings` entry in the result document.

## Release Notes

See [CHANGELOG.md](CHANGELOG.md) for the full history.

## License

[MIT](LICENSE) — © xmmmmmovo
