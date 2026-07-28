# C/C++ Debug Variable JSON 设计方案

## 1. 目标

本扩展用于在 VS Code 调试会话中，将用户选定的 C/C++ Debug Variable 或 Watch 表达式递归展开，并复制为包含变量名与全部可访问数据的 JSON。

首版目标：

- 支持当前活动调试会话。
- 支持从 Debug Variables 视图选择变量名，也支持输入/选择 Watch 表达式。
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

## 4. 推荐用户流程

1. 用户启动并暂停 C/C++ 调试。
2. 执行命令 `Copy Debug Variable as JSON`。
3. 扩展检查 `vscode.debug.activeDebugSession` 和暂停状态。
4. 用户选择来源：
   - `Evaluate expression`：输入变量名/Watch 表达式；
   - `Select scope variable`：从当前 frame 的 Locals/Arguments 读取候选变量。
5. 用户选择 frame（默认当前线程的 top frame），或使用默认 frame。
6. 扩展读取顶层变量。
7. 递归读取所有子变量，生成 JSON-safe 对象。
8. 将格式化 JSON 写入剪贴板，并显示摘要；用户可选择保存文件。

首版建议优先实现“输入 Watch 表达式”路径，因为它不需要模拟 Debug 视图的选中状态；随后再增加作用域变量选择。

## 5. 命令与配置建议

### 命令

- `copy-cpp-debug-variable.copyAsJson`：主命令。
- `copy-cpp-debug-variable.copyFromWatch`：直接输入 Watch 表达式。
- `copy-cpp-debug-variable.saveAsJson`：复制并保存。

### 配置

- `copy-cpp-debug-variable.maxDepth`：默认 32。
- `copy-cpp-debug-variable.maxVariables`：默认 10000。
- `copy-cpp-debug-variable.maxArrayItems`：默认 1000。
- `copy-cpp-debug-variable.variablePagingSize`：默认 100。
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

### 阶段 C：作用域与 frame 选择

- 请求 `threads`、`stackTrace`、`scopes`。
- 让用户选择线程/frame/scope 变量。
- 对选中的变量直接从 `variablesReference` 开始递归。

### 阶段 D：保存、测试与体验

- 增加保存 JSON 文件功能。
- 增加取消、进度通知和结果摘要。
- 编写 mock DebugSession 单元测试和 Extension Host 集成测试。
- 更新 README、命令标题和故障排查说明。

## 7. 验收标准

- 在 cppdbg 暂停断点时，输入普通标量表达式可复制合法 JSON。
- 结构体/类至少递归展开到配置的最大深度。
- 数组不会因长度过大无限请求，超限时结果明确标注截断。
- 同名兄弟变量不会互相覆盖（必要时使用数组或保留节点元数据）。
- 指针和重复引用不会导致无限递归。
- 没有活动会话、未暂停、表达式失败、DAP 不支持时，用户收到明确提示。
- `pnpm run check-types`、`pnpm run lint` 和测试通过。
