# 测试与验证计划

## 单元测试

使用 mock `vscode.DebugSession`，验证：

1. `evaluate` 标量结果生成叶子节点。
2. 多层 `variablesReference` 正确递归。
3. `maxDepth`、`maxVariables`、`maxArrayItems` 生效。
4. 重复引用不会无限递归。
5. DAP 响应缺少字段时返回可识别错误。
6. 某个子节点失败时保留其他节点并记录 warning。
7. CancellationToken 取消后不再发送新请求。
8. JSON 输出始终可被 `JSON.parse` 解析。

### 右键菜单入口

使用 mock `DebugCopyDeps` + mock 菜单参数，验证：

9. `isVariableMenuContext` 接受真实菜单参数，拒绝 `undefined`、`{}`、`variable` 非对象或 `name` 非字符串的情况（决定是否退化为输入框流程）。
10. `menuContextToVariable` 只保留已知 DAP 字段，丢弃 VS Code 内部附加字段。
11. 菜单路径不发送 `evaluate`，直接按 `variablesReference` 展开，`source === 'variables'`。
12. `expression` 优先取 `evaluateName`，缺失时回退到 `name`（数组元素、匿名成员）。
13. `sessionId` 命中映射表时使用对应会话，而不是活动会话（多会话调试）。
14. `sessionId` 未命中时回退到活动会话；完全没有会话时提示并终止。
15. 子变量读取失败时仍产出文档，并把错误写入 `warnings`。
16. 菜单路径的保存流程用 `evaluateName` 生成默认文件名，且不弹输入框。

### 字符串类节点

17. `isStringLikeType` 接受 `std::u8string` / `std::pmr::*` / `std::__cxx11::basic_string<...>` / `std::__1::basic_string<...>` / `std::__y::basic_string<...>` / `std::byte[N]` / `std::byte *` / `const std::byte[N]`，并继续拒绝 `std::vector<char>` / `std::array<char, N>` / `std::array<std::byte, N>` / `std::map<std::string, int>` / `std::deque<char>` / `std::list<char>` / `MyString` / 裸 `char` / `wchar_t`。`getCharKind` 把 `std::byte` / `const std::byte` 归为 `utf8`。
18. `parseCharUnits` 解析 `NN '...'` / `0xNN '...'` / `'\xNN'` / `'\uNNNN'` / `[uLU]'X'` / `'X'`，不可识别输入返回 `undefined`。
19. `readStringValue` 在 cppdbg / cppvsdbg 风格的 char 子节点下重建字符串，对只有 `[size]` / `[capacity]` / `[allocator]` 等命名兄弟节点的情形返回 `undefined`；空 `std::string` 返回 `""` 且不发送 `variables` 请求；分页参数正确；取消时抛 `ReaderCancellationError`。
20. `readVariableTree` 对 `std::u8string` / `std::string` / `std::u16string` 视为叶子：如有 char 子节点则 `value` 为重建的完整文本；如无 char 子节点则 `value` 保持适配器展示值且不暴露任何内部字段；`std::vector<char>` 等容器仍然展开；`std::byte[N]` 同样视为叶子并按 `std::byte` 子节点重建成 UTF-8 字符串。

## 集成测试矩阵

| 场景 | 预期 |
| --- | --- |
| `int`, `bool`, enum | 保留原始展示值、类型和变量名 |
| struct/class | 展开字段 |
| C 数组 / `std::vector` | 展开索引，超限截断 |
| `std::string` / `char*` | 保留适配器返回值；如有 `[N]` char 子节点则替换为重建的完整文本 |
| `std::u8string` / `std::wstring` / `std::u16string` / `std::u32string` | 同上，对应编码见 §3.1 |
| `std::string`（`indexedItems === 0`） | `value: ""`，不发送 `variables` 请求 |
| `std::pmr::string` / `std::__cxx11::basic_string<...>` / 自定义 allocator | 视为叶子，按 §3.1 走重建或回退 |
| `std::byte[N]` / `std::byte *`（PMR 背书缓冲） | 视为叶子；如有 `std::byte` 子节点则按字节序列重建成 UTF-8 字符串，否则保留适配器展示值 |
| null pointer | 不报错，不继续展开 |
| pointer/reference | 保留地址/类型，防止循环 |
| `<optimized out>` | 保留展示字符串并给 warning |
| 未暂停 | 命令被阻止并提示 |
| 无活动 DebugSession | 命令被阻止并提示 |
| cppdbg 与其他 DAP adapter | 能力差异转为 warning，而非崩溃 |
| Variables 视图右键任意节点 | 菜单出现 `Copy as JSON` / `Save as JSON`，以该节点为根导出 |
| Watch 视图右键表达式 | 同上，`expression` 为表达式本身 |
| 恢复运行（非 stopped） | 菜单项隐藏（`variablesReference` 已失效） |
| 多个并行调试会话 | 按 `sessionId` 读取被点击变量所属的会话 |

## 手工验收

使用 `demo/` 下包含嵌套 struct、数组、指针、STL 容器的 C++ 示例，在断点处分别测试：

1. Locals 中右键 `alice` → `Copy as JSON`，确认剪贴板 JSON 完整且 `source` 为 `variables`。
2. 展开到 `alice.address.city` 右键复制，确认结果以 `city` 为根、`expression` 为 `alice.address.city`。
3. 右键数组元素 `[0]`，确认没有表达式也能导出（验证不走 `evaluate`）。
4. Watch 视图右键表达式复制。
5. `Save as JSON` 的默认文件名、编码和大对象响应时间。
6. 单步恢复运行后确认菜单项消失。

## 发布前检查

```text
pnpm run check-types
pnpm run lint
pnpm test
pnpm run package
```

所有测试失败必须在发布记录中保留实际输出，不得以“适配器差异”静默忽略。
