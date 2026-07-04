# Python 3.15 新特性：Lazy Import 详解

> 📺 视频来源：[【python】lazy import详解，3.15新特性它来啦！](https://www.bilibili.com/video/BV1ELGY6sExb/)
> 
> 👤 作者：**码农高天**（Python 核心开发者，CPython 贡献者）
> 
> 📅 发布时间：2026-05-23
> 
> ⏱️ 视频时长：约 6 分 07 秒
> 
> 📊 数据：播放 23,805 | 点赞 1,385 | 投币 430 | 收藏 326 | 转发 152

---

## 一、视频简介

这期视频介绍了 Python 3.15 引入的一个重要新语法——**lazy import（延迟导入）**，对应 **PEP 810（Explicit lazy imports）**。作者码农高天作为 Python 核心开发者，从实践角度出发，详细讲解了 lazy import 的动机、用法、底层机制以及最佳实践。几乎每一个使用 Python 的人都值得了解这一特性。

---

## 二、背景与动机

### 2.1 传统 import 的问题

在 Python 中，当你执行 `import` 语句时，模块的代码会被**立即完整执行**。对于大多数模块这没有问题，但如果某个模块启动过程漫长，就会拖慢整个程序的执行。

Python 标准库中约 **17% 的 import**（730 个文件中近 3500 条）被开发者手动放在函数或方法内部，目的就是延迟执行。这说明开发者已经在手动实现 lazy import，但这种做法：

- 代码分散，难以维护
- 模糊了模块的完整依赖关系
- 单个不慎的顶层 import 就会破坏延迟效果

### 2.2 现有的临时方案

开发者常用的临时解决方案包括：

1. **函数内导入（inline import）**：将 `import` 放在函数体内
2. **`importlib.util.LazyLoader`**：标准库提供的延迟加载器，但有明显局限
3. **第三方库**（如 `lazy_loader`、`wrapt`）：各有各的实现

这些方案没有统一标准，存在运行时开销、内省困难等问题。

---

## 三、Lazy Import 语法详解

### 3.1 基本语法

Python 3.15 新增了一个**软关键字（soft keyword）** `lazy`，放在 `import` 语句的最前面：

```python
# 延迟导入整个模块
lazy import json

# 延迟从模块中导入特定名称
lazy from json import dumps

# 支持 as 别名
lazy import foo as foo1
lazy from foo import bar as bar1
```

> **注意**：`lazy` 是软关键字，只在 `import` 语句前有特殊含义，其他地方仍可用作变量名。

### 3.2 对比示例：Eager vs Lazy

**传统方式（Eager Import）：**

```python
# main.py
print("Program starting")
from other import some_fn
print("Other module imported")
some_fn()
print("Program ended")

# other.py
print("Other module evaluation started")
from time import sleep
sleep(2)  # 模拟慢加载
print("Other module evaluation ended")

def some_fn():
    print("some_fn run")
```

输出：
```
Program starting
Other module evaluation started
[两秒延迟]
Other module evaluation ended
Other module imported
some_fn run
Program ended
```

**使用 Lazy Import：**

```python
print("Program starting")
lazy from other import some_fn
print("Other module imported")
some_fn()
print("Program ended")
```

输出：
```
Program starting
Other module imported
Other module evaluation started
[两秒延迟]
Other module evaluation ended
some_fn run
Program ended
```

**关键区别**：import 语句本身不再造成任何延迟，延迟只在**实际使用**导入的函数时才发生。

---

## 四、底层机制

### 4.1 代理对象（Proxy Object）

当 Python 检测到 `lazy import` 时，不会执行正常的导入过程，而是创建一个 **代理对象（proxy object）**，类型为 `types.LazyImportType`。这个代理等待程序尝试使用该模块时，才触发真正的导入动作。

```python
import sys

lazy import json

print('json' in sys.modules)  # False - 模块尚未加载

# 首次使用触发加载
result = json.dumps({"hello": "world"})

print('json' in sys.modules)  # True - 现在已加载
```

### 4.2 字节码实现

Lazy import 通过修改 4 个字节码指令实现：

| 字节码 | 作用 |
|--------|------|
| `IMPORT_NAME` | `lazy` 语法在 oparg 中设置标志位，调用 `_PyEval_LazyImportName()` |
| `IMPORT_FROM` | 检查源是否为 lazy 对象，若是则创建 lazy proxy |
| `LOAD_GLOBAL` | 检查加载的对象是否为 lazy import，若是则执行 reification |
| `LOAD_NAME` | 同上，用于模块级别和类级别 |

### 4.3 自适应特化（Adaptive Specialization）

Python 的自适应解释器在 2-3 次访问后会优化掉 lazy 检查：

```
=== 特化前 ===
LOAD_GLOBAL              0 (json)
LOAD_ATTR                2 (dumps)

=== 3次调用后（特化） ===
LOAD_GLOBAL_MODULE       0 (json)    # 直接访问，无 lazy 检查
LOAD_ATTR_MODULE         2 (dumps)
```

**结论：reification 后的 lazy import 性能开销为零。**

---

## 五、高级特性

### 5.1 全局 Lazy Import 控制

可以通过多种方式全局启用/禁用 lazy import：

```python
import sys

# 编程方式
sys.set_lazy_imports("all")    # 所有 import 都变 lazy
sys.set_lazy_imports("normal") # 只有显式标记 lazy 的才延迟
sys.set_lazy_imports("none")   # 禁用所有 lazy import
```

也可通过命令行或环境变量：

```bash
python -X lazy_imports=all main.py
PYTHON_LAZY_IMPORTS=all python main.py
```

优先级：`sys.set_lazy_imports()` > `-X lazy_imports` > `PYTHON_LAZY_IMPORTS` 环境变量

### 5.2 过滤器函数

使用 `sys.set_lazy_imports_filter()` 可以精细控制哪些模块延迟导入：

```python
import sys

def mod_filter(importing, imported, fromlist):
    """返回 True 表示允许 lazy，False 表示强制 eager"""
    side_effect_modules = {'legacy_plugin_system', 'metrics_collector'}
    if imported in side_effect_modules:
        return False  # 强制立即导入
    return True       # 允许延迟导入

sys.set_lazy_imports_filter(mod_filter)
sys.set_lazy_imports("all")
```

### 5.3 向后兼容：`__lazy_modules__`

对于需要同时兼容旧版本 Python 的代码：

```python
# 在 Python 3.15+ 上自动 lazy，旧版本上正常 eager
__lazy_modules__ = ["expensive_module", "another_heavy_module"]
import expensive_module
from another_heavy_module import MyClass
```

`__lazy_modules__` 是一个列表，Python 会在每条 `import` 语句执行时检查该列表，决定是否延迟。

---

## 六、语法限制

以下场景**不允许**使用 `lazy`：

```python
# ❌ 函数内部
def foo():
    lazy import json          # SyntaxError

# ❌ 类体内
class Bar:
    lazy import json          # SyntaxError

# ❌ try/except 块内
try:
    lazy import json          # SyntaxError
except ImportError:
    pass

# ❌ star import
lazy from json import *       # SyntaxError

# ❌ __future__ import
lazy from __future__ import annotations  # SyntaxError
```

---

## 七、实际应用场景

### 7.1 加速 CLI 工具启动

命令行工具（如有多子命令的工具）即使用 `--help` 也会加载大量不需要的模块。Lazy import 可以减少 **50-70%** 的启动时间。

### 7.2 替代 `if TYPE_CHECKING` 模式

```python
# 之前
from typing import TYPE_CHECKING
if TYPE_CHECKING:
    from collections.abc import Sequence, Mapping

def process(items: Sequence[str]) -> Mapping[str, int]:
    ...

# 现在
lazy from collections.abc import Sequence, Mapping  # 无运行时开销

def process(items: Sequence[str]) -> Mapping[str, int]:
    ...
```

### 7.3 替代函数内导入

```python
# 之前：函数内导入（每次调用都重新解析）
def process_data(data):
    import json
    return json.dumps(data)

# 现在：模块级 lazy import（只加载一次）
lazy import json

def process_data(data):
    return json.dumps(data)  # 首次调用时加载，之后零开销
```

### 7.4 减少内存占用

大型应用通常导入数千个模块，lazy import 可以延迟未使用模块的加载，实测可节省 **30-40%** 的内存。

---

## 八、注意事项与最佳实践

### 8.1 副作用时机变化

```python
# 问题：插件在 import 时自动注册
# my_plugin.py
from plugin_registry import register_plugin

@register_plugin("MyPlugin")
class MyPlugin:
    pass

# main.py
lazy import my_plugin
# ⚠️ 插件尚未注册！模块未加载！
```

**建议**：使用显式发现机制而非依赖 import 副作用。

### 8.2 错误时机变化

```python
lazy from json import dumsp  # 拼写错误

print("App started successfully")  # 正常执行
result = dumsp({"key": "value"})   # ❌ ImportError 在这里才报错
```

错误报告会通过**异常链**同时显示定义位置和使用位置，方便调试。

### 8.3 循环导入

Lazy import **不能**自动解决循环导入问题。只有在两个模块都不在模块初始化期间访问对方时才有效。

### 8.4 `globals()` 和 `__dict__` 不触发 reification

```python
lazy import json
g = globals()
print(type(g['json']))  # <class 'LazyImport'>，不是 module

# 需要手动 resolve
resolved = g['json'].resolve()
print(type(resolved))  # <class 'module'>
```

### 8.5 线程安全

Reification 遵循现有的 import 锁机制，只有一个线程执行导入并原子性地更新绑定，线程安全。

---

## 九、与 PEP 690 的区别

PEP 690 是之前被否决的 lazy import 提案，PEP 810 与其核心区别：

| 特性 | PEP 690（已否决） | PEP 810（已接受） |
|------|-------------------|-------------------|
| 方式 | 隐式全局 | 显式 `lazy` 关键字 |
| 范围 | 级联到依赖 | 仅影响当前语句 |
| 实现 | 修改核心 dict | 使用 proxy 对象 |
| 兼容性 | 生态风险大 | 完全向后兼容 |

---

## 十、性能基准

对 Python 标准库 278 个顶层模块的基准测试：

| 配置 | 平均耗时 (ms) | 额外开销 |
|------|---------------|----------|
| Eager import（基线） | 161.2 ± 4.3 | 0% |
| Lazy + filter 强制 eager | 161.7 ± 4.2 | +0.3% |
| Lazy + filter 允许 lazy + reification | 162.0 ± 4.0 | +0.5% |
| Lazy + 无 filter + reification | 161.4 ± 4.3 | +0.1% |

**结论：lazy import 机制本身几乎零开销。**

---

## 十一、总结

Python 3.15 的 lazy import（PEP 810）是一个**本地化、显式、可控、细粒度**的特性：

1. **本地化**：lazy 只影响标记的那一行 import，不会级联
2. **显式**：通过 `lazy` 关键字明确标识，代码可读性强
3. **可控**：库作者自主决定是否使用，不影响下游用户
4. **细粒度**：可以逐条 import 采用，支持渐进式迁移

适用人群：几乎所有 Python 开发者，特别是：
- CLI 工具开发者（加速启动）
- 大型应用开发者（减少内存）
- 类型标注重度用户（替代 `TYPE_CHECKING`）
- 需要兼容多版本 Python 的库作者

---

## 参考资料

- [PEP 810 – Explicit lazy imports](https://peps.python.org/pep-0810/)
- [What's new in Python 3.15](https://docs.python.org/3.15/whatsnew/3.15.html)
- [InfoWorld: Speed boost your Python programs with new lazy imports](https://www.infoworld.com/article/4145854/speed-boost-your-python-programs-with-new-lazy-imports.html)
- [视频链接 - Bilibili](https://www.bilibili.com/video/BV1ELGY6sExb/)
- [YouTube 镜像](https://www.youtube.com/watch?v=UYdxbADcYEw)