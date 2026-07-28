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

## 集成测试矩阵

| 场景 | 预期 |
| --- | --- |
| `int`, `bool`, enum | 保留原始展示值、类型和变量名 |
| struct/class | 展开字段 |
| C 数组 / `std::vector` | 展开索引，超限截断 |
| `std::string` / `char*` | 保留适配器返回值及子节点 |
| null pointer | 不报错，不继续展开 |
| pointer/reference | 保留地址/类型，防止循环 |
| `<optimized out>` | 保留展示字符串并给 warning |
| 未暂停 | 命令被阻止并提示 |
| 无活动 DebugSession | 命令被阻止并提示 |
| cppdbg 与其他 DAP adapter | 能力差异转为 warning，而非崩溃 |

## 手工验收

使用一个包含嵌套 struct、数组、指针、STL 容器的 C++ 示例，在断点处分别测试 Locals 和 Watch 表达式。确认剪贴板内容、截断提示、保存文件编码和大对象响应时间。

## 发布前检查

```text
pnpm run check-types
pnpm run lint
pnpm test
pnpm run package
```

所有测试失败必须在发布记录中保留实际输出，不得以“适配器差异”静默忽略。
