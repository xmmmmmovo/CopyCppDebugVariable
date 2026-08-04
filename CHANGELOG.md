# Change Log

All notable changes to the "copy-cpp-debug-variable" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- 新增配置 `copy-cpp-debug-variable.showSuccessNotification`（默认 false）：关闭后复制 / 保存成功不再弹出右下角提示，警告与错误提示不受影响。
- 修复 `std::byte[N]` / `std::byte *` 只显示 ~10 条 byte 子节点的退化：`readMemory` 走 DAP spec 字段 `data`（保留 `bytes` 别名兜底），并新增 `tryEvaluateForFullByteDump` 路径——按 MSVC format specifier（`,N` size hint、`!` raw、`,s8` UTF-8）依次 evaluate，任一返回非平凡的完整 byte dump 即物化全部 N 个 child；`parseCppvsdbgByteDump` 改用 per-entry 正则 matchAll，避免 `,` 切错带 `,` glyph 的 entry；`formatByteAsCppvsdbg` 对 `\`、`'`、`,` 做转义以保持 dump 字符串结构稳定；同步接受 DAP spec 的 `indexedVariables` 字段（`indexedItems` 作为别名保留）。
- 修复 `std::byte[N]` 全量 dump 仍拉不到、只能退到 ~10 条 preview 的剩余场景：`tryEvaluateForFullByteDump` 现在还会试 `,N,x`（hex 渲染）与 `(unsigned char*)name,N[,x]`（` ,N` 只对指针类表达式生效时显式指针 cast），并在拿到预期尺寸的 dump 后提前停止；`parseCppvsdbgByteDump` 同时支持裸 hex（`0xNN`）、裸 decimal、裸 glyph（`'\xNN'`）条目，不再要求每条都有 `<decimal> '<glyph>'` 形态（cppvsdbg 的 hex / 数组视图 dump 全是这种形态，旧正则一条都匹配不上）；`parseCppvsdbgByteDumpEntries` 改走与主解析相同的 per-entry 正则，glyph 里的 `,`（0x2c）不再被 split 切成两半；per-index evaluate 由"首个空结果即 break"改为"连续 8 次 miss 才 break"，避免某个 0x00 字节恰好返回空 result 时把 2048 个字节截成 10 个。
- 修复 `std::byte[N]` evaluate 拿到截断 value 字符串（cppvsdbg 忽略 `,N` 对 value 的展开）但仍能展开的剩余场景：新增 `readByteChildrenViaExpandableEvaluate`——`name,N` / `name,N,!` / `name,!` / 裸 `name` 的 evaluate 响应里带 `variablesReference` 时（IDE Watch 里 `pmr_buf,2048` 展开能看到 `[0]..[N-1]`），走 `variables` 分页把全部 N 个字节 children 拉回来，比 per-index evaluate 少几十倍 round trip。
- 修复 `std::byte[N]` **输入自带 variablesReference 时仍退化成 ~10 条 preview** 的场景：`readVariableTree` 对 byte buffer 不再要求"无 ref 才走字节路径"——输入自带 ref 时直接 `variables` 分页物化全部字节 children（等价于 IDE 展开后的数据），不再走 `readStringValue` 把二进制当 UTF-8 文本解码；分页结果少于 64 条视为截断 ref（小 buffer / 文本 buffer 会落到 `readStringValue` 文本解码，保持旧行为），继续回退到 per-index / dump fallback。
- 新增配置 `copy-cpp-debug-variable.mergeByteBufferIntoValue`（默认 true）：`std::byte[N]` / `std::byte *` 作为 string-like 叶子时，把全部字节按 UTF-8 解码合并成单个 `value` 字符串（PMR 文本 buffer 得到可读文本）；二进制内容（解码含 U+FFFD 替换符）自动退回物化全部字节 children。关闭该配置则一律物化 `[0]..[N-1]` 字节 children。

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
