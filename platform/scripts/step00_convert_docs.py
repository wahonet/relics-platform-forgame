"""Step 00 | 四普登记表 docx → Markdown 档案(大模型结构化提取)。

输入:
    data/input/00_docs/{分组}/*.docx     普查登记表(分组一般按乡镇建文件夹,
                                          也支持 docx 直接平铺在 00_docs 下)
输出:
    data/input/01_relics/markdown/{分组}/*.md

断点续传:
- 已存在且有效的 md 自动跳过(校验大小 >= 500 字节且含「基本信息」「坐标数据」章节)
- md 先写 .tmp 再原子改名,中途断电/中断不会留下半截文件被误判为已完成
- 进度账本 data/output/logs/step00_progress.json 实时记录 完成/失败 清单
- 中断后直接重跑本步即可续传,只处理缺失或损坏的文件

其他:
- API Key / base_url / 模型取自 config.yaml api.siliconflow(可在系统管理页配置)
- 并发数可用 config.api.siliconflow.extract_concurrency 调整(默认 2)
- docx 解析不依赖 python-docx,直接读 OOXML(word/document.xml)
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
import xml.etree.ElementTree as ET
import zipfile
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

from _common import get_logger, get_paths, load_config

log = get_logger("step00_convert_docs")

DEFAULT_CONCURRENCY = 2
MAX_RETRIES = 4
RETRY_DELAY_S = 12
MAX_TOKENS = 18000
TEMPERATURE = 0.05
MIN_VALID_SIZE = 500  # 小于此字节数的 md 视为无效,重新提取
# 有效 md 必须包含的章节标记(防止半截输出被当成完成)
REQUIRED_SECTIONS = ("## 基本信息", "## 坐标数据")

_W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

SYSTEM_PROMPT = """你是一名专业的文物档案结构化信息提取助手，专门处理"第四次全国文物普查不可移动文物登记表"。

你的任务：把输入的档案原文精确提取为规范 Markdown。

====================
一、最重要规则：Checkbox 识别
====================
文档中符号含义如下：
- 已选中：● 或 ☑
- 未选中：〇 或 □

提取时：
- 只输出已选中的文字内容
- 未选中项完全不输出
- 如果该字段没有任何选中项，则输出：（无）

示例：
原文：〇全国重点文物保护单位  〇省级文物保护单位  ●市级和县级文物保护单位  〇尚未核定
提取结果：市级和县级文物保护单位

原文：☑明代  □清代
提取结果：明代

【特别注意：保存现状字段】
保存现状只有以下5个选项：
〇好  〇较好  〇一般  〇较差  〇差
必须严格找到唯一的●所在项，不得与相邻项混淆。

====================
二、坐标数据规则（GIS关键字段）
====================
- 经纬度必须逐字符原样保留，禁止省略、四舍五入、改写
- 海拔高程保留原始数值（如29.388）
- 测点类型必须精确区分：边界点 / 中心点 / 标志点 / 其他
- 若"分组"为空，统一填：（无）
- "备注"列来自"本体边界坐标测点登记表"中的"备 注"
- 若某点备注为空或原文为"无"，统一填：（无）

====================
三、文字内容规则
====================
- 简介：完整逐字复制，不得删减、概括、改写
- 备注：完整逐字复制；若为空填：（无）
- 审核意见：完整复制
- 人名、地名、数字、单位必须与原文一致

====================
四、数值与单位规则
====================
- 面积、尺寸等数值必须连同单位一起提取，例如：47.18平方米、1:20000

====================
五、清单完整性规则
====================
- 图纸清单、照片清单每一条都要完整提取，不允许漏条目
- 序号、编号、名称、图号/照片号、比例、绘制人/摄影者、时间、方位、文字说明、总页数都要保留

====================
六、空值规则
====================
- 字段明确为空时填：（无）
- 附属文物如果没有内容，表格保留一行：（无）
- 抽查人、抽查日期、抽查结论常常为空，统一填：（无）

====================
七、输出要求
====================
- 严格按照下面模板输出，不要输出任何模板外解释
- 只输出 Markdown 正文

# {文物名称}

## 基本信息

| 字段 | 内容 |
|------|------|
| 档案编号 | |
| 普查性质 | |
| 文物大类 | |
| 省份 | |
| 地级市 | |
| 县区 | |
| 调查人 | |
| 调查日期 | |
| 审定人 | |
| 审定日期 | |
| 抽查人 | |
| 抽查日期 | |

## 位置信息

| 字段 | 内容 |
|------|------|
| 详细地址 | |
| 是否整体迁移 | |
| 是否变更或消失 | |

## 坐标数据

| 序号 | 分组 | 测点类型 | 纬度 | 经度 | 海拔(m) | 测点说明 | 备注 |
|------|------|---------|------|------|---------|---------|------|

## 文物属性

| 字段 | 内容 |
|------|------|
| 总面积 | |
| 文物级别 | |
| 所属文物保护单位名称 | |
| 已公布保护范围 | |
| 已公布建设控制地带 | |
| 年代 | |
| 统计年代 | |
| 类别（大类） | |
| 类别（细分） | |

## 权属与使用

| 字段 | 内容 |
|------|------|
| 所有权性质 | |
| 产权单位或人 | |
| 使用单位或人 | |
| 上级管理机构 | |
| 所属行业或系统 | |
| 开放状况 | |
| 使用用途 | |

## 文物构成

### 本体文物

| 序号 | 分组 | 名称 | 类别 | 面积或数量 |
|------|------|------|------|-----------|

### 附属文物

| 序号 | 分组 | 名称或类别 | 面积或数量 |
|------|------|-----------|-----------|

## 简介

（完整复制原文简介）

## 保存现状

| 字段 | 内容 |
|------|------|
| 现状评估 | |
| 已完成保护措施 | |
| 主要影响因素 | |

## 专题与名录

| 名录类别 | 是否列入 |
|---------|---------|
| 革命文物名录 | 否 |
| 世界文化遗产 | 否 |
| 大运河规划体系 | 否 |
| 长城资源系统 | 否 |
| 中国重要农业文化遗产 | 否 |
| 中华老字号 | 否 |
| 国家工业遗产 | 否 |
| 中央企业工业文化遗产 | 否 |

## 审核信息

| 字段 | 内容 |
|------|------|
| 审核意见 | |
| 抽查结论 | |

## 备注

（完整复制原文备注，若无则填（无））

## 其他资料登记

| 序号 | 名称 | 编号 | 类别 | 数量 | 保存地点 | 备注 |
|------|------|------|------|------|---------|------|

## 图纸清单

| 序号 | 图纸编号 | 图纸名称 | 图号 | 比例 | 绘制人 | 绘制时间 | 总页数 |
|------|---------|---------|------|------|------|---------|------|

## 照片清单

| 序号 | 照片编号 | 照片名称 | 照片号 | 摄影者 | 拍摄时间 | 拍摄方位 | 文字说明 | 总页数 |
|------|---------|---------|------|------|---------|---------|---------|------|
"""


def docx_to_text(docx_path: Path) -> str:
    """读 OOXML 提取段落与表格文本(段落一行,表格行以 tab 分隔)。"""
    with zipfile.ZipFile(docx_path, "r") as z:
        root = ET.fromstring(z.read("word/document.xml"))

    body = root.find(f"{_W_NS}body")
    if body is None:
        return ""

    lines: list[str] = []
    for element in body:
        tag = element.tag.rsplit("}", 1)[-1]
        if tag == "p":
            text = "".join(t.text or "" for t in element.iter(f"{_W_NS}t")).strip()
            if text:
                lines.append(text)
        elif tag == "tbl":
            for row in element.iter(f"{_W_NS}tr"):
                cells = []
                for cell in row.iter(f"{_W_NS}tc"):
                    ct = "".join(t.text or "" for t in cell.iter(f"{_W_NS}t")).strip()
                    if ct:
                        cells.append(ct)
                if cells:
                    lines.append("\t".join(cells))
    return "\n".join(lines)


def collect_tasks(input_root: Path, output_root: Path) -> list[dict]:
    """扫描 00_docs 下的 docx(支持分组文件夹或平铺)。"""
    tasks: list[dict] = []

    def _add(docx: Path, group: str) -> None:
        if docx.name.startswith("~$"):
            return
        out_dir = output_root / group if group else output_root
        tasks.append({
            "group": group,
            "docx": docx,
            "out": out_dir / f"{docx.stem}.md",
        })

    if not input_root.exists():
        return tasks
    for entry in sorted(input_root.iterdir()):
        if entry.is_dir():
            for docx in sorted(entry.glob("*.docx")):
                _add(docx, entry.name)
        elif entry.suffix.lower() == ".docx":
            _add(entry, "")
    return tasks


def _strip_md_fence(text: str) -> str:
    """模型偶尔会包一层 ```markdown 围栏,剥掉。"""
    t = text.strip()
    m = re.match(r"^```(?:markdown|md)?\s*\n(.*)\n```\s*$", t, re.DOTALL)
    return m.group(1).strip() if m else t


def _md_is_valid(path: Path) -> bool:
    """已存在的 md 是否算「已完成」:大小 + 关键章节双重校验。"""
    try:
        if not path.exists() or path.stat().st_size < MIN_VALID_SIZE:
            return False
        content = path.read_text(encoding="utf-8", errors="replace")
        return all(sec in content for sec in REQUIRED_SECTIONS)
    except OSError:
        return False


def _atomic_write(path: Path, content: str) -> None:
    """先写 .tmp 再改名,保证任何时刻磁盘上要么无文件要么是完整文件。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    os.replace(tmp, path)


class ProgressLedger:
    """进度账本:实时落盘 完成/失败 清单,供中断后查看与续跑参考。"""

    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()
        self.data = {"completed": [], "failed": {}, "updated_at": ""}
        if path.exists():
            try:
                old = json.loads(path.read_text(encoding="utf-8"))
                self.data["completed"] = list(old.get("completed") or [])
                self.data["failed"] = dict(old.get("failed") or {})
            except Exception:  # noqa: BLE001
                pass

    def mark(self, name: str, ok: bool, err: str = "") -> None:
        with self._lock:
            if ok:
                if name not in self.data["completed"]:
                    self.data["completed"].append(name)
                self.data["failed"].pop(name, None)
            else:
                self.data["failed"][name] = err[:300]
            self.data["updated_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            try:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                self.path.write_text(
                    json.dumps(self.data, ensure_ascii=False, indent=2), encoding="utf-8")
            except OSError as e:
                log.warning("进度账本写入失败: %s", e)


def convert_one(client, model: str, task: dict) -> tuple[bool, str]:
    """单文件提取,带重试。返回 (成功, 说明)。"""
    out: Path = task["out"]
    if _md_is_valid(out):
        return True, "skip"

    try:
        doc_text = docx_to_text(task["docx"])
    except Exception as e:  # noqa: BLE001
        return False, f"docx 解析失败: {e}"
    if not doc_text.strip():
        return False, "文档文本为空"

    last_err = ""
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            t0 = time.time()
            resp = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": SYSTEM_PROMPT},
                    {"role": "user",
                     "content": f"请严格提取以下文物档案内容并按模板输出：\n\n---\n{doc_text}\n---"},
                ],
                temperature=TEMPERATURE,
                max_tokens=MAX_TOKENS,
            )
            content = _strip_md_fence(resp.choices[0].message.content or "")
            if not all(sec in content for sec in REQUIRED_SECTIONS):
                last_err = "输出缺少关键章节(基本信息/坐标数据)"
                log.warning("[%s] 第 %d 次输出不完整,重试", task["docx"].name, attempt)
                if attempt < MAX_RETRIES:
                    time.sleep(RETRY_DELAY_S)
                continue
            _atomic_write(out, content)
            return True, f"ok {time.time() - t0:.1f}s"
        except Exception as e:  # noqa: BLE001
            last_err = f"{type(e).__name__}: {e}"
            log.warning("[%s] 第 %d 次失败: %s", task["docx"].name, attempt, last_err)
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_DELAY_S)
    return False, last_err


def main() -> int:
    paths = get_paths()
    cfg = load_config()

    log.info("=" * 56)
    log.info("step00 启动 | docx → Markdown 档案提取")

    tasks = collect_tasks(paths.input_docs, paths.input_markdown)
    if not tasks:
        log.info("data/input/00_docs 下没有 docx,跳过本步。")
        return 0

    pending = [t for t in tasks if not _md_is_valid(t["out"])]
    log.info("docx 总数 %d / 已有有效 md %d / 待提取 %d (断点续传:只处理缺失或损坏的)",
             len(tasks), len(tasks) - len(pending), len(pending))
    if not pending:
        log.info("全部已提取完毕。")
        return 0

    sf = (cfg.get("api") or {}).get("siliconflow") or {}
    api_key = (sf.get("key") or "").strip()
    if not api_key or (api_key.startswith("${") and api_key.endswith("}")):
        log.error("未配置 SiliconFlow API Key(config.api.siliconflow.key),无法做 docx 提取。"
                  "请在「系统管理 → API 配置」填写后重试。")
        return 2
    model = sf.get("default_model") or "deepseek-ai/DeepSeek-V3.2"
    base_url = sf.get("base_url") or "https://api.siliconflow.cn/v1"
    try:
        concurrency = max(1, min(int(sf.get("extract_concurrency", DEFAULT_CONCURRENCY)), 8))
    except (TypeError, ValueError):
        concurrency = DEFAULT_CONCURRENCY

    try:
        from openai import OpenAI
    except ImportError:
        log.error("未安装 openai 库,请先 pip install openai")
        return 2
    client = OpenAI(api_key=api_key, base_url=base_url, timeout=300)

    ledger = ProgressLedger(paths.output_logs / "step00_progress.json")
    log.info("模型: %s / 并发: %d / 进度账本: %s", model, concurrency, ledger.path)

    ok = fail = 0
    failures: list[str] = []
    t_start = time.time()
    with ThreadPoolExecutor(max_workers=concurrency) as pool:
        futures = {pool.submit(convert_one, client, model, t): t for t in pending}
        for fut in as_completed(futures):
            t = futures[fut]
            success, msg = fut.result()
            ledger.mark(t["docx"].name, success, "" if success else msg)
            if success:
                ok += 1
                log.info("[%d/%d] %s %s", ok + fail, len(pending), t["docx"].name, msg)
            else:
                fail += 1
                failures.append(t["docx"].name)
                log.error("[%d/%d] %s 失败: %s", ok + fail, len(pending), t["docx"].name, msg)

            done = ok + fail
            if done % 50 == 0 and done < len(pending):
                elapsed = time.time() - t_start
                eta_min = elapsed / done * (len(pending) - done) / 60
                log.info("── 进度 %d/%d (%.0f%%),预计还需 %.0f 分钟",
                         done, len(pending), done / len(pending) * 100, eta_min)

    log.info("提取完成: 成功 %d / 失败 %d / 总耗时 %.1f 分钟",
             ok, fail, (time.time() - t_start) / 60)
    if failures:
        log.warning("失败 %d 个(重跑本步即可续传,详见进度账本): %s%s",
                    len(failures), failures[:10], " …" if len(failures) > 10 else "")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
