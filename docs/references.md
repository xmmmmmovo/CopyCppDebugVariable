# 参考资料与 API 备注

## 官方资料

- [Your First Extension](https://code.visualstudio.com/api/get-started/your-first-extension)
- [VS Code Extension API](https://code.visualstudio.com/api/references/vscode-api)
- [Debugging Extension Guide](https://code.visualstudio.com/api/extension-guides/debugger-extension)
- [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)
- [DAP Variables Request](https://microsoft.github.io/debug-adapter-protocol/specification#Requests_Variables)
- [DAP Evaluate Request](https://microsoft.github.io/debug-adapter-protocol/specification#Requests_Evaluate)
- [Contribution Points: contributes.menus](https://code.visualstudio.com/api/references/contribution-points#contributes.menus)
- [When Clause Contexts](https://code.visualstudio.com/api/references/when-clause-contexts)

## 菜单参数的可信度说明

官方文档列出了 `debug/variables/context`，但没有说明命令参数结构；`debug/watch/context` 甚至没有出现在文档表格里，只存在于 VS Code 的可贡献菜单注册表（`MenuId.DebugWatchContext`）中。本项目使用的参数形状 `{ sessionId, container, variable }` 来自 VS Code 内部 `IVariablesContext`（`variablesView.ts` 的 `getVariablesContext`），`variable` 由 `Variable.toDebugProtocolObject()` 生成，包含 `name`、`value`、`type`、`evaluateName`、`variablesReference`、`memoryReference`。

因此：

- 该结构按“可能随版本变化”处理，全部字段可选读取 + 运行时校验。
- 校验失败时命令退化为输入表达式流程，不抛异常、不静默失败。
- 升级 `engines.vscode` 或发现菜单点击无效时，优先复核这一参数形状。

## 依赖说明

本扩展不直接依赖 `clangd` 或 `C/C++` 扩展的内部实现。它依赖调试适配器公开提供的 DAP 能力，因此可以与 Microsoft C/C++ 扩展的 `cppdbg` 以及其他兼容 DAP 的 C/C++ 调试器协作。`clangd` 主要负责语言服务，不提供通用 Debug Variables API；实际变量读取由调试适配器完成。

## 兼容性原则

- 不导入第三方扩展的内部模块。
- 不假定命令 ID、内部 TreeView 或 WebView 存在。
- 通过 `DebugSession.type` 识别适配器类型只用于元数据或提示，不能据此假定响应格式。
- 所有扩展字段采用可选读取和运行时校验。
