# Change Log

All notable changes to the "copy-cpp-debug-variable" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- 新增配置 `copy-cpp-debug-variable.showSuccessNotification`（默认 false）：关闭后复制 / 保存成功不再弹出右下角提示，警告与错误提示不受影响。

## v0.0.1

- 在 Variables 与 Watch 视图右键菜单中新增 `Copy as JSON` / `Save as JSON`，直接导出被点击的变量子树。
- 菜单入口跳过 `evaluate`，对数组元素、匿名成员等没有合法表达式的节点同样可用。
- 支持多调试会话：按菜单参数中的 `sessionId` 定位变量所属会话。
- 字符串类类型（`std::string` / `std::u8string` / `std::wstring` / `std::u16string` / `std::u32string` / `std::string_view` / `std::basic_string<...>` / `std::pmr::*` / `std::__cxx11::basic_string<...>` / `std::__1::basic_string<...>` / `const char *` / `char[N]` / `wchar_t *` / `std::byte[N]` / `std::byte *` 等）一律视为叶子，不再展开内部 buffer / union。`value` 优先级：空容器（`indexedItems === 0`）→ `""`；有 char / byte 子节点 → 重建出的完整 UTF-8 / UTF-16 文本；以上都没拿到且 `value` 字段是 cppvsdbg 字节 dump（`std::byte[N]` / `std::byte *` 常见，如 `0x... {168 '�', 232 '�', ..., ...}`）→ 解析字节并按 UTF-8 解码；都拿不到才丢弃 adapter 的展示值（cppvsdbg 对 `std::string` 的截断 preview 不再保留），叶子节点只剩 `type` / `memoryReference`。
- `isStringLikeType` 现在覆盖 `std::u8string`、`std::pmr::*` 别名，以及被 ABI 命名空间包裹的 `std::__cxx11::basic_string<...>` / `std::__1::basic_string<...>` 等形式（`basic_string<...>` 已对任意 allocator 模板参数生效）。
- `isStringLikeType` 进一步覆盖 `std::byte[N]` / `std::byte *`（PMR 背书缓冲等场景）：如有 byte 子节点按字节序列重建成 UTF-8 字符串；如没有 byte 子节点但 value 字段是 cppvsdbg 的字节 dump，则解析后按 UTF-8 解码；`getCharKind` 把 `std::byte` 归为 `utf8`。
- 非 string-like 容器在展开成 children 后丢掉 adapter 的 `value` 摘要，避免 summary + 子树并存。
- 默认 `copy-cpp-debug-variable.maxDepth` 从 32 调整为 8，过深时仍可通过配置调大。
- Initial release
