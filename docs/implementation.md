# 技术实现说明

## 1. 模块划分

建议将 `src` 拆分为以下模块，避免所有 DAP 逻辑堆积在 `extension.ts`：

- `extension.ts`：注册命令、串联用户流程、显示错误和进度。
- `debugSession.ts`：封装 `DebugSession.customRequest`，统一请求和错误转换。
- `dapTypes.ts`：定义 `EvaluateResponse`、`Variable`、`Scope`、`StackFrame` 等最小类型，以及运行时类型守卫。
- `variableReader.ts`：从变量引用递归读取树，负责限制、循环检测、分页和取消。
- `jsonSerializer.ts`：把 DAP 返回值转换为稳定的 JSON-safe 结构。
- `output.ts`：剪贴板、JSON 文件保存、结果摘要。

## 2. DAP 请求顺序

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

### Scope 变量

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
  "source": "watch",
  "expression": "person",
  "sessionType": "cppdbg",
  "capturedAt": "2026-07-28T00:00:00.000Z",
  "data": { "name": "person", "value": "...", "children": {} },
  "warnings": []
}
```

时间戳仅作为输出信息，不参与逻辑判断。

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
