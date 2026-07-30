# 技术实现说明

## 1. 模块划分

当前 `src` 的实际结构（保持薄 `extension.ts`，纯逻辑可单测）：

- `extension.ts`：唯一接触 `vscode` 命名空间的文件。构造 `DebugCopyDeps`、注册 4 个命令、维护 `sessionId -> DebugSession` 映射。
- `debugCopy.ts`：命令编排。解析入口参数（右键菜单上下文 / 输入框）、组装结果文档、处理错误与取消。仅 `import type * as vscode`。
- `variableReader.ts`：DAP 请求封装、类型守卫、递归读取树，负责限制、循环检测、分页和取消。
- `src/test/extension.test.ts`：基于 mock `DebugSession` 与 mock `DebugCopyDeps` 的单元测试。

依赖注入（`DebugCopyDeps`）是这里的关键：剪贴板、保存对话框、配置读取、时间戳、会话查找全部作为依赖传入，因此编排逻辑可以在没有 Extension Host 的情况下断言。

## 2. DAP 请求顺序

### 右键菜单变量（无需 evaluate）

```text
menu argument { sessionId, container, variable }
  -> getSessionById(sessionId) ?? activeDebugSession
  -> variable.variablesReference
  -> readVariables(variablesReference)
  -> serialize
```

VS Code 已经在展开树时持有该变量的句柄，因此菜单参数里的 `variablesReference` 可直接使用。这条路径不调用 `evaluate`，所以对 `[0]`、匿名 union 成员、`operator[]` 结果这类没有合法表达式的节点同样有效。

### Watch 表达式

```text
activeDebugSession
  -> choose frame (optional)
  -> evaluate { expression, frameId, context: "watch" }
  -> result + variablesReference
  -> readVariables(variablesReference)
  -> serialize
```

`evaluate` 的结果通常包含 `result`、`type`、`variablesReference`、可选 `memoryReference`。当 `variablesReference === 0` 时，结果是叶子值，不再调用 `variables`。

### Scope 变量（未实现，保留设计）

```text
threads -> choose stopped thread
  -> stackTrace(threadId) -> choose frame
  -> scopes(frameId) -> choose scope
  -> variables(scope.variablesReference)
  -> choose variable
  -> readVariables(variable.variablesReference)
```

`scopes` 和 `stackTrace` 的响应字段不应直接信任，需检查数组是否存在以及 ID 是否为 number。

## 3. 递归算法

核心函数可以设计为：

```ts
readVariableTree(
  variable: DapVariableLike,
  context: ReadContext,
  depth: number,
  path: string[],
): Promise<JsonValue>
```

处理规则：

1. 先把当前变量的 `name`、`value`、`type`、`evaluateName` 等元信息记录到节点。
2. `variablesReference === 0` 时返回叶子节点。
3. `depth >= maxDepth` 时返回当前值，并附加截断标记。
4. 对 `variablesReference` 维护访问集合；重复引用时停止向下展开，标记 `cycle: true`。
5. 调用 `variables` 读取子节点，优先使用 DAP 的 `start`/`count` 分段读取大数组。
6. 每读取一个子节点递归处理，并累加全局变量计数。
7. 发生单个子节点错误时保留已读数据，并在节点 `errors` 数组中记录错误，不应丢弃整个结果。
8. 字符串类类型（`std::string` / `std::string_view` / `std::basic_string<...>` / `const char *` / `char[N]` / `wchar_t *` 等）一律视为叶子：适配器已经返回可读的展示值，把它们的内部 buffer/union 展开会变成上百个无意义的字符子节点。判定由 `variableReader.isStringLikeType()` 完成，按 `type` 字段做正则匹配。

注意：DAP 的 `variablesReference` 是调试适配器生成的句柄，不等同于内存地址；它只能在同一调试会话生命周期内使用。

## 4. JSON 输出结构

为了同时满足“变量名 + 值 + 子数据”，建议使用稳定的节点结构，而不是简单地把所有子节点强行合并到一个对象：

```json
{
  "name": "person",
  "value": "{...}",
  "type": "Person",
  "children": {
    "name": {
      "name": "name",
      "value": "Alice",
      "type": "const char *"
    },
    "age": {
      "name": "age",
      "value": "42",
      "type": "int"
    }
  }
}
```

原因：C/C++ 变量可能出现同名字段、数组索引不是合法对象键、DAP value 常常是展示字符串而非 JSON 原生类型。可在后续配置中提供 `compact` 模式，但首版应优先保证信息不丢失。

建议的顶层文档：

```json
{
  "schemaVersion": 1,
  "source": "variables",
  "expression": "alice.address.city",
  "sessionType": "cppdbg",
  "capturedAt": "2026-07-28T00:00:00.000Z",
  "data": { "name": "city", "value": "...", "children": {} },
  "warnings": [],
  "truncated": false,
  "nodeCount": 12
}
```

`source` 区分入口：`variables` 表示来自 Variables/Watch 右键菜单，`watch` 表示来自命令面板输入的表达式。`expression` 在菜单路径下取 `evaluateName`，缺失时回退到变量名——它只是给人看的标识和默认文件名来源，不参与逻辑判断，时间戳同理。

## 5. 值转换策略

DAP 返回的 `value` 是字符串，不能可靠地直接解析成 JSON：例如 C++ 字符串、十六进制地址、`<optimized out>`、`true/false` 和枚举都可能混合出现。因此：

- 默认保留原始展示值为 string。
- 额外保留 `type`、`evaluateName`、`memoryReference`（若存在）。
- 不对字符串做激进的数字/布尔推断。
- 无法访问的值使用 `null` 或节点元信息表达，并加入 warning。

## 6. 错误与取消

需要区分：

- 未启动调试：提示“请先启动调试”。
- 调试未暂停：提示“请在断点处暂停后重试”。
- 没有活动会话：终止命令。
- `evaluate` 失败：显示 Debug Adapter 返回的 message。
- 子变量读取失败：保留父节点和已读兄弟节点，记录 warning。
- 达到限制：正常完成，但在结果中标记 `truncated`。
- 用户取消：停止后续请求，不把取消误报为适配器故障。

所有 DAP 调用应支持 `CancellationToken`，在每次递归和分页前检查取消状态。

## 7. 性能与安全边界

- 串行读取默认更稳定；可在同一层有限并发，但首版不建议无限 `Promise.all`。
- 使用请求计数、节点计数和深度限制。
- 不记录完整变量内容到日志，避免敏感数据泄露。
- 错误消息可记录命令名和表达式摘要，但不记录可能包含密钥的值。
- 剪贴板和文件保存属于用户明确触发的外部输出，应在命令结果中清楚提示。

## 8. 右键菜单集成

### 8.1 菜单贡献

```jsonc
"menus": {
  "debug/variables/context": [
    { "command": "copy-cpp-debug-variable.copySelectedAsJson", "when": "debugState == 'stopped'", "group": "5_cutcopypaste@100" },
    { "command": "copy-cpp-debug-variable.saveSelectedAsJson", "when": "debugState == 'stopped'", "group": "5_cutcopypaste@101" }
  ],
  "debug/watch/context": [ /* 同上 */ ],
  "commandPalette": [
    { "command": "copy-cpp-debug-variable.copySelectedAsJson", "when": "false" },
    { "command": "copy-cpp-debug-variable.saveSelectedAsJson", "when": "false" }
  ]
}
```

`5_cutcopypaste` 是内置 `Copy Value` / `Copy as Expression` 所在的分组；`@100` / `@101` 把新项排在该组末尾，视觉上与复制类操作聚在一起。`debug/watch/context` 未出现在官方贡献点文档中，但它确实注册在 VS Code 的可贡献菜单表里（`MenuId.DebugWatchContext`），与 `debug/variables/context` 同级。

### 8.2 命令参数结构

VS Code 调用菜单命令时传入的对象与内部 `IVariablesContext` 一致：

```ts
{
  sessionId?: string,
  container?: { name?, variablesReference? } | { expression: string }, // Watch 顶层项是 { expression }
  variable: {
    name: string,
    value?: string,
    type?: string,
    evaluateName?: string,
    variablesReference: number,   // 0 表示叶子
    memoryReference?: string,
  }
}
```

约束与假设：

1. 这是**未在公开 API 文档中承诺**的结构，因此必须运行时校验，不能直接强转。`isVariableMenuContext()` 只要求 `variable.name` 是字符串；不满足时命令退化为输入框流程，而不是抛错。
2. `menuContextToVariable()` 只挑选已知的 DAP 字段，忽略 VS Code 可能新增的内部字段，避免它们进入 JSON 输出。
3. `variablesReference` 是会话生命周期内的句柄，恢复运行后即失效，所以菜单项用 `when: debugState == 'stopped'` 限制。
4. Watch 视图顶层表达式的 `evaluateName` 等于表达式本身；Variables 视图中的子节点则由适配器给出，数组元素、匿名成员可能没有 `evaluateName`，此时回退到 `name`。

### 8.3 会话定位

菜单只给 `sessionId` 字符串，而 DAP 请求需要 `vscode.DebugSession` 实例。`extension.ts` 用 `onDidStartDebugSession` / `onDidTerminateDebugSession` 维护映射表，并在激活时补入当前活动会话；查找顺序为：

```text
activeDebugSession.id === sessionId ? activeDebugSession : sessions.get(sessionId) ?? activeDebugSession
```

因为扩展默认惰性激活，若第一次激活发生在调试开始之后，映射表会缺少已有会话；`activationEvents: ["onDebug"]` 保证调试启动时扩展已经在监听。最后一层回退到活动会话，是为了在映射意外缺失时仍能工作——多会话场景下这可能读到错误的会话，但 `variablesReference` 属于另一会话时适配器会直接返回错误，并被记录成节点 `errors`，不会静默产出错误数据。

### 8.4 与输入框路径的合并

`copyVariableAsJson(deps, arg?)` 和 `saveVariableAsJson(deps, arg?)` 共用 `resolveTarget()`：

- 参数通过 `isVariableMenuContext` → 直接构造 `ReadTarget { session, expression, source: 'variables', variable }`。
- 否则 → 检查活动会话、弹输入框、`source: 'watch'`，`variable` 留空，由 `runRead()` 触发 `evaluate`。

两条路径之后完全共享递归读取、限制、错误处理和输出逻辑，因此菜单入口没有引入第二套截断/循环检测规则。
