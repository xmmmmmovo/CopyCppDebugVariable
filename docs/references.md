# 参考资料与 API 备注

## 官方资料

- [Your First Extension](https://code.visualstudio.com/api/get-started/your-first-extension)
- [VS Code Extension API](https://code.visualstudio.com/api/references/vscode-api)
- [Debugging Extension Guide](https://code.visualstudio.com/api/extension-guides/debugger-extension)
- [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/)
- [DAP Variables Request](https://microsoft.github.io/debug-adapter-protocol/specification#Requests_Variables)
- [DAP Evaluate Request](https://microsoft.github.io/debug-adapter-protocol/specification#Requests_Evaluate)

## 依赖说明

本扩展不直接依赖 `clangd` 或 `C/C++` 扩展的内部实现。它依赖调试适配器公开提供的 DAP 能力，因此可以与 Microsoft C/C++ 扩展的 `cppdbg` 以及其他兼容 DAP 的 C/C++ 调试器协作。`clangd` 主要负责语言服务，不提供通用 Debug Variables API；实际变量读取由调试适配器完成。

## 兼容性原则

- 不导入第三方扩展的内部模块。
- 不假定命令 ID、内部 TreeView 或 WebView 存在。
- 通过 `DebugSession.type` 识别适配器类型只用于元数据或提示，不能据此假定响应格式。
- 所有扩展字段采用可选读取和运行时校验。
