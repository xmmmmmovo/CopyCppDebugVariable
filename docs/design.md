# C/C++ Debug Variable JSON 设计方案

## 1. 目标

本扩展用于在 VS Code 调试会话中，将用户选定的 C/C++ Debug Variable 或 Watch 表达式递归展开，并复制为包含变量名与全部可访问数据的 JSON。

首版目标：

- 支持当前活动调试会话。
- 支持从 Debug Variables 视图选择变量名，也支持输入/选择 Watch 表达式。
- 在 Variables / Watch 视图右键菜单中直接提供 `Copy as JSON` / `Save as JSON`，无需手工输入表达式。
- 递归读取结构体、类、数组、指针等具有 `variablesReference` 的子节点。
- 将结果复制到系统剪贴板，并可选地保存为 JSON 文件。
- 在无法读取、循环引用、深度/数量过大时给出可理解的提示，而不是阻塞扩展宿主。

## 2. 范围与非目标

### 范围

- 主要面向 `cppdbg`（Microsoft C/C++ 扩展）和 `clangd` 配合的 C/C++ 开发环境。
- 使用 VS Code Debug Adapter Protocol（DAP）请求读取变量，不依赖读取 VS Code 内部 Debug 视图 DOM。
- 通过 VS Code 公共 API 实现命令、Quick Pick、剪贴板和文件保存。

### 非目标

- 不修改调试进程中的变量。
- 不实现 C/C++ 表达式解析器；表达式求值交给当前 Debug Adapter。
- 不保证所有 Debug Adapter 都提供完整的子变量信息。DAP 能力由具体适配器决定。
- 不绕过调试器的权限、优化、不可读内存或表达式限制。

## 3. 关键 API 判断

VS Code 公共 API 没有提供“直接取得 Debug Variables/Watch 树节点”的通用读取接口。`vscode.DebugSession` 提供 `customRequest(command, args)`，因此实现应直接向当前 Debug Adapter 发送 DAP 请求：

1. `threads`：取得线程列表（必要时选择停止线程）。
2. `stackTrace`：取得调用栈和 `frameId`。
3. `scopes`：取得 Locals/Arguments 等作用域及其 `variablesReference`。
4. `variables`：根据 `variablesReference` 分页/分段读取子变量。
5. `evaluate`：对用户输入的 Watch 表达式求值，取得顶层变量及 `variablesReference`。

这种方式能够复用 cppdbg/clangd 相关调试适配器的实际能力，但不能假定每个适配器支持完全相同的参数或返回字段。请求失败必须被捕获并转换为用户提示及结果中的错误元数据。

另外，虽然不存在“读取 Debug 视图节点”的 API，但 VS Code 会把被右键点击的变量作为**命令参数**传给 `debug/variables/context` 与 `debug/watch/context` 菜单命令。这条路径已经带有 `variablesReference`，因此菜单入口不需要 `evaluate`，也不依赖 Debug 视图 DOM。参数结构见 `docs/implementation.md` 第 8 节。

## 4. 推荐用户流程

### 4.1 右键菜单（首选）

1. 用户在断点处暂停。
2. 在 Variables（Locals/Registers 等）或 Watch 视图中右键某个变量。
3. 选择 `Copy as JSON` 或 `Save as JSON`。
4. 扩展用菜单参数中的 `sessionId` 定位会话，用 `variablesReference` 递归展开该节点。
5. 写入剪贴板或保存文件，并提示节点数量。

该路径没有输入框，也不会二次求值，因此对同名变量、数组元素、匿名成员都是准确的。

### 4.2 手工输入表达式

1. 用户启动并暂停 C/C++ 调试。
2. 执行命令 `Copy Debug Variable as JSON`。
3. 扩展检查 `vscode.debug.activeDebugSession` 和暂停状态。
4. 用户输入变量名/Watch 表达式。
5. 扩展调用 `evaluate` 取得顶层变量。
6. 递归读取所有子变量，生成 JSON-safe 对象。
7. 将格式化 JSON 写入剪贴板，并显示摘要；用户可选择保存文件。

两条路径共用同一个读取器与输出文档结构，只在 `source` 字段上区分（`variables` 与 `watch`）。

## 5. 命令与配置

### 命令

| 命令 ID | 标题 | 入口 |
| --- | --- | --- |
| `copy-cpp-debug-variable.copyAsJson` | Copy Debug Variable as JSON | 命令面板，输入表达式 |
| `copy-cpp-debug-variable.saveAsJson` | Save Debug Variable as JSON | 命令面板，输入表达式 |
| `copy-cpp-debug-variable.copySelectedAsJson` | Copy as JSON | Variables / Watch 右键菜单 |
| `copy-cpp-debug-variable.saveSelectedAsJson` | Save as JSON | Variables / Watch 右键菜单 |

菜单命令通过 `menus.commandPalette` 的 `when: false` 从命令面板隐藏：它们没有上下文参数时会退化成输入框流程，直接在面板里暴露两套入口只会让用户困惑。

### 菜单

- `debug/variables/context` 与 `debug/watch/context`，`group: 5_cutcopypaste@100/@101`，紧随内置的 `Copy Value` / `Copy as Expression`。
- `when: debugState == 'stopped'`：变量句柄只在暂停期间有效。
- 不限制 `debugType`。读取逻辑是通用 DAP，限制适配器类型会漏掉自定义 C/C++ 适配器，与 `docs/references.md` 的兼容性原则冲突。
- `activationEvents: ["onDebug"]`：保证调试开始时扩展就已激活，从而完整维护 `sessionId -> DebugSession` 映射。

### 配置

- `copy-cpp-debug-variable.maxDepth`：默认 8。
- `copy-cpp-debug-variable.maxVariables`：默认 10000。
- `copy-cpp-debug-variable.maxArrayItems`：默认 1000。
- `copy-cpp-debug-variable.variablePagingSize`：默认 100。
- `copy-cpp-debug-variable.showSuccessNotification`：默认 false。控制复制 / 保存成功后的右下角提示；默认不打扰，警告与错误提示始终展示。
- `copy-cpp-debug-variable.includeMetadata`：默认 true。
- `copy-cpp-debug-variable.stringifySpecialValues`：默认 true。

配置必须有合理上限，避免误操作导致大量 DAP 请求或扩展宿主内存占用。

## 6. 分阶段实现

### 阶段 A：基础闭环

- 替换示例 Hello World 命令。
- 检查活动调试会话和暂停状态。
- Quick Pick 输入表达式。
- 调用 `evaluate`，读取一层数据。
- 生成 JSON，复制到剪贴板。

### 阶段 B：递归读取

- 新增 DAP 类型守卫和请求封装。
- 根据 `variablesReference` 调用 `variables`。
- 递归处理 `children`，保留变量名。
- 增加深度、数量、数组项限制。
- 处理 `memoryReference`、指针、空引用和错误响应。

### 阶段 C：右键菜单入口（已实现）

- 贡献 `debug/variables/context` 与 `debug/watch/context` 菜单项。
- 复用 VS Code 传入的变量上下文，跳过 `evaluate`，直接从 `variablesReference` 递归。
- 按 `sessionId` 定位会话，支持多会话调试。
- 保留命令面板的表达式输入路径作为回退。

### 阶段 D：保存、测试与体验

- 增加保存 JSON 文件功能。
- 增加取消、进度通知和结果摘要。
- 编写 mock DebugSession 单元测试和 Extension Host 集成测试。
- 更新 README、命令标题和故障排查说明。

### 阶段 E：字符串内容重建

- 扩展 `isStringLikeType` 覆盖 `std::u8string`、`std::pmr::*`、`std::__cxx11::basic_string<...>` / `std::__1::basic_string<...>` 等 ABI 形式。
- 字符串类节点改为尝试从 char 子节点重建完整文本写入 `value`；当适配器不暴露 char 子节点时回退到 cppvsdbg 字节 dump 解析（`std::byte[N]` / `std::byte *` 场景）或丢弃原展示值（cppvsdbg 对 `std::string` 的 truncated preview 不是 string 本身），叶子只剩 `type` / `memoryReference`。
- 详见 `docs/implementation.md` §3.1 和 `docs/testing.md` 第 17-20 条。

### 阶段 F：字节缓冲作为字符串类叶子

- `isStringLikeType` 进一步覆盖 `std::byte[N]` / `std::byte *`（PMR 背书缓冲场景，cppvsdbg 默认会把它拆成 N 个 `std::byte` 子节点）。
- `getCharKind` 把 `std::byte` 归为 `utf8`，让 `readStringValue` 能把 `std::byte` 子节点按字节序列重建成 UTF-8 字符串；适配器不暴露 byte 子节点但 `value` 是 cppvsdbg 字节 dump 时（`0x... {NN '?', ..., ...}`），由 `parseCppvsdbgByteDump` 解析出字节并按 UTF-8 解码作为叶子 `value`；再不行才丢弃。
- 详见 `docs/implementation.md` §3.1 和 `docs/testing.md` 第 17-20 条。

### 阶段 G：非 string-like 容器展开后丢弃 value

- struct / class / `std::vector<int>` / `std::pmr::monotonic_buffer_resource` 等非 string-like 容器在展开成 children 后，把父节点 adapter 给的 `value` 摘要主动丢掉，避免与子树并存；string-like 节点通过更早的 `isStringLikeType` 拦截已直接 return，value 是重建后的字符串。
- 详见 `docs/implementation.md` §3 和 `docs/testing.md` 第 17-20 条。

## 7. 验收标准

- 在 cppdbg 暂停断点时，输入普通标量表达式可复制合法 JSON。
- 在 Variables/Watch 视图右键任意变量都能看到 `Copy as JSON` / `Save as JSON`，且结果以被点击的节点为根。
- 右键路径不发送 `evaluate` 请求；数组元素、匿名成员等没有合法表达式的节点同样可复制。
- 字符串类节点（`std::string` / `std::u8string` / `std::pmr::*` / 自定义 allocator / ABI-tagged `basic_string<...>` / `std::byte[N]` / `std::byte *`）在导出的 JSON 中只有 `value` 字段（无 `children`）。`value` 优先级：空容器（`indexedItems === 0`）→ `""`；从 char / byte 子节点重建的完整 UTF-8 / UTF-16 文本；从 cppvsdbg 字节 dump 解析出的字节序列（按 UTF-8 解码，覆盖 `std::byte[N]` / `std::byte *` 拿不到子节点的场景）；以上都没拿到时丢弃 adapter 的展示值（cppvsdbg 对 `std::string` 的截断 preview 不再保留），叶子只剩 `type` / `memoryReference`。
- 非 string-like 容器在展开成 `children` 后父节点的 `value` 摘要会被丢弃，避免读者同时看到 summary 和完整子树。
- 结构体/类至少递归展开到配置的最大深度。
- 数组不会因长度过大无限请求，超限时结果明确标注截断。
- 同名兄弟变量不会互相覆盖（必要时使用数组或保留节点元数据）。
- 指针和重复引用不会导致无限递归。
- 没有活动会话、未暂停、表达式失败、DAP 不支持时，用户收到明确提示。
- `pnpm run check-types`、`pnpm run lint` 和测试通过。
