# Debug Variable Demo

这是用于测试 VS Code 扩展递归复制 Debug Variable / Watch 数据的 C++23 示例。

## 构建

```bash
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build
```

Windows MSVC：

```powershell
cmake -S . -B build -DCMAKE_BUILD_TYPE=Debug
cmake --build build --config Debug
```

## 调试建议

在 `main.cpp` 的 `main` 函数中 `people` 初始化完成后设置断点。程序暂停后，可在 Watch 中测试：

```text
people
people[0]
people[0].address
people[0].scores
company
company.employees
linked
linked->next
```

推荐使用扩展命令 `Copy Debug Variable as JSON`，逐个输入上面的表达式验证标量、嵌套结构体、数组、容器、指针和链表数据。
