# Change Log

All notable changes to the "copy-cpp-debug-variable" extension will be documented in this file.

Check [Keep a Changelog](http://keepachangelog.com/) for recommendations on how to structure this file.

## [Unreleased]

- 在 Variables 与 Watch 视图右键菜单中新增 `Copy as JSON` / `Save as JSON`，直接导出被点击的变量子树。
- 菜单入口跳过 `evaluate`，对数组元素、匿名成员等没有合法表达式的节点同样可用。
- 支持多调试会话：按菜单参数中的 `sessionId` 定位变量所属会话。
- Initial release