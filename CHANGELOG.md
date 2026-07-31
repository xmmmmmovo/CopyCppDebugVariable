# Change Log

All notable changes to the "copy-cpp-debug-variable" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- 在 Variables 与 Watch 视图右键菜单中新增 `Copy as JSON` / `Save as JSON`，直接导出被点击的变量子树。
- 菜单入口跳过 `evaluate`，对数组元素、匿名成员等没有合法表达式的节点同样可用。
- 支持多调试会话：按菜单参数中的 `sessionId` 定位变量所属会话。
- 字符串类类型（`std::string` / `std::string_view` / `std::basic_string<...>` / `const char *` / `char[N]` / `wchar_t *` 等）不再展开内部 buffer/union，直接保留适配器展示值，避免子节点爆炸。
- `isStringLikeType` 现在覆盖 `std::u8string`、`std::pmr::*` 别名，以及被 ABI 命名空间包裹的 `std::__cxx11::basic_string<...>` / `std::__1::basic_string<...>` 等形式（`basic_string<...>` 已对任意 allocator 模板参数生效）。
- 默认 `copy-cpp-debug-variable.maxDepth` 从 32 调整为 8，过深时仍可通过配置调大。
- Initial release