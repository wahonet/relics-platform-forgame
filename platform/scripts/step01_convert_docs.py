"""Step 01 | DOCX 档案 → 结构化 Markdown。

输入:  data/input/01_archives/[<township>/]*.docx
输出:  data/output/markdown/<township>/<stem>.md
进度:  data/output/logs/step01_progress.json(断点续传)

已存在且大小 >= MIN_VALID_SIZE 的 md 会被跳过,失败任务重试 max_retries 次。
退出码:0 全成功 / 1 有失败 / 10 缺 API Key / 11 输入为空。
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
import time
from pathlib import Path

import aiohttp
from docx import Document
from docx.oxml.ns import qn

from _common import get_logger, get_paths, load_config

STEP_ID = "step01"


# 四普档案结构化提取提示词,输出严格遵循文末 Markdown 模板。
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
例如：
〇好  〇较好  〇一般  ●较差  〇差
提取结果：较差

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
- 简介中的自然段落尽量保留；如果输入文本无法明确分段，则保证内容完整即可
- 备注：完整逐字复制；若为空填：（无）
- 审核意见：完整复制
- 人名、地名、数字、单位必须与原文一致

====================
四、数值与单位规则
====================
- 面积、尺寸等数值必须连同单位一起提取
- 例如：47.18平方米、1:20000、29.388
- 如果原文"本体文物"里面积是 47平方米，就输出 47平方米，不要擅自改成 47.18平方米

====================
五、清单完整性规则
====================
- 图纸清单每一条都要完整提取
- 照片清单每一条都要完整提取
- 序号、编号、名称、图号/照片号、比例、绘制人/摄影者、时间、方位、文字说明、总页数都要保留
- 不允许漏条目

====================
六、空值规则
====================
- 字段明确为空时填：（无）
- 附属文物如果没有内容，表格保留一行：（无）
- 抽查人、抽查日期、抽查结论常常为空，统一填：（无）

====================
七、输出要求
====================
- 严格按照下面模板输出
- 不要输出任何模板外解释
- 不要输出"以下是提取结果"之类废话
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

TEMPERATURE = 0.05
MAX_TOKENS = 18000
RETRY_DELAY = 15
TIMEOUT_SECONDS = 300
MIN_VALID_SIZE = 500  # 小于此字节数的 md 视为无效,需重新提取


def docx_to_text(docx_path: str) -> str:
    doc = Document(docx_path)
    lines: list[str] = []
    for element in doc.element.body:
        tag = element.tag.split("}")[-1] if "}" in element.tag else element.tag
        if tag == "p":
            text = "".join(node.text or "" for node in element.iter(qn("w:t")))
            text = text.strip()
            if text:
                lines.append(text)
        elif tag == "tbl":
            for row in element.iter(qn("w:tr")):
                cells = []
                for cell in row.iter(qn("w:tc")):
                    cell_text = "".join(node.text or "" for node in cell.iter(qn("w:t")))
                    cell_text = cell_text.strip()
                    if cell_text:
                        cells.append(cell_text)
                if cells:
                    lines.append("\t".join(cells))
    return "\n".join(lines)


def load_progress(path: Path) -> dict:
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            pass
    return {"completed": [], "failed": []}


def save_progress(path: Path, progress: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(progress, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


def collect_tasks(input_root: Path, output_root: Path) -> list[dict]:
    """扫描 DOCX,兼容 `<township>/xxx.docx` 与平铺 `xxx.docx`(后者归到 `_root`)。"""
    tasks: list[dict] = []
    output_root.mkdir(parents=True, exist_ok=True)

    def _handle_docx(docx_file: Path, township_dir_name: str) -> None:
        if docx_file.name.startswith("~$"):  # Word 临时锁文件
            return
        stem = docx_file.stem
        out_township_dir = output_root / township_dir_name
        out_township_dir.mkdir(parents=True, exist_ok=True)
        tasks.append({
            "township": township_dir_name,
            "filename": docx_file.name,
            "stem": stem,
            "docx_path": str(docx_file),
            "output_path": str(out_township_dir / f"{stem}.md"),
        })

    for entry in sorted(input_root.iterdir()):
        if entry.is_dir():
            for docx_file in sorted(entry.glob("*.docx")):
                _handle_docx(docx_file, entry.name)

    for docx_file in sorted(input_root.glob("*.docx")):
        _handle_docx(docx_file, "_root")

    return tasks


async def call_api_async(
    session: aiohttp.ClientSession,
    endpoint: str,
    headers: dict,
    model: str,
    doc_text: str,
    filename: str,
    max_retries: int,
    log,
) -> str | None:
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": f"请严格提取以下文物档案内容并按模板输出：\n\n---\n{doc_text}\n---",
            },
        ],
        "temperature": TEMPERATURE,
        "max_tokens": MAX_TOKENS,
        "stream": False,
    }

    for attempt in range(1, max_retries + 1):
        t0 = time.time()
        try:
            async with session.post(
                endpoint,
                headers=headers,
                json=payload,
                timeout=aiohttp.ClientTimeout(total=TIMEOUT_SECONDS),
            ) as resp:
                if resp.status != 200:
                    err_text = await resp.text()
                    log.warning(
                        f"[{filename}] HTTP {resp.status} 第{attempt}次失败: {err_text[:300]}"
                    )
                    if attempt < max_retries:
                        await asyncio.sleep(RETRY_DELAY)
                    continue
                data = await resp.json()
                content = data["choices"][0]["message"]["content"]
                usage = data.get("usage", {}) or {}
                prompt_tokens = usage.get("prompt_tokens", 0)
                completion_tokens = usage.get("completion_tokens", 0)
                dt = time.time() - t0
                log.info(
                    f"[{filename}] 成功 | 输入:{prompt_tokens} 输出:{completion_tokens} tokens | 耗时:{dt:.1f}s"
                )
                return content
        except asyncio.TimeoutError:
            log.warning(f"[{filename}] 超时，第{attempt}次")
        except aiohttp.ServerDisconnectedError:
            log.warning(f"[{filename}] Server disconnected，第{attempt}次")
        except Exception as e:
            log.error(f"[{filename}] 异常，第{attempt}次：{type(e).__name__}: {e}")

        if attempt < max_retries:
            await asyncio.sleep(RETRY_DELAY)

    log.error(f"[{filename}] 已达到最大重试次数，放弃")
    return None


async def process_task(
    task: dict,
    semaphore: asyncio.Semaphore,
    session: aiohttp.ClientSession,
    endpoint: str,
    headers: dict,
    model: str,
    max_retries: int,
    progress: dict,
    progress_path: Path,
    log,
) -> bool:
    async with semaphore:
        filename = task["filename"]
        stem = task["stem"]
        out_path = task["output_path"]

        if os.path.exists(out_path):
            sz = os.path.getsize(out_path)
            if sz >= MIN_VALID_SIZE:
                log.info(f"↷ 跳过（已存在 {sz} 字节）: [{task['township']}] {filename}")
                return True
            log.warning(f"⚠ 文件过小（{sz} 字节），重新提取: [{task['township']}] {filename}")

        log.info(f"→ 开始处理: [{task['township']}] {filename}")

        try:
            doc_text = docx_to_text(task["docx_path"])
        except Exception as e:
            log.error(f"[{filename}] 读取 docx 失败: {e}")
            _mark_failed(progress, stem)
            save_progress(progress_path, progress)
            return False

        if not doc_text.strip():
            log.error(f"[{filename}] 文档文本为空")
            _mark_failed(progress, stem)
            save_progress(progress_path, progress)
            return False

        log.info(f"[{filename}] 文本长度 {len(doc_text)} 字符")

        md = await call_api_async(
            session, endpoint, headers, model, doc_text, filename, max_retries, log
        )

        if md is None:
            _mark_failed(progress, stem)
            save_progress(progress_path, progress)
            return False

        if "## 基本信息" not in md or "## 坐标数据" not in md:
            log.warning(f"[{filename}] 输出结构可能不完整，但仍保存")

        try:
            Path(out_path).parent.mkdir(parents=True, exist_ok=True)
            Path(out_path).write_text(md, encoding="utf-8")
            log.info(f"[{filename}] 已保存: {out_path}")
        except Exception as e:
            log.error(f"[{filename}] 保存失败: {e}")
            _mark_failed(progress, stem)
            save_progress(progress_path, progress)
            return False

        if stem not in progress["completed"]:
            progress["completed"].append(stem)
        if stem in progress.get("failed", []):
            progress["failed"].remove(stem)
        save_progress(progress_path, progress)
        return True


def _mark_failed(progress: dict, stem: str) -> None:
    if stem not in progress.setdefault("failed", []):
        progress["failed"].append(stem)


async def main_async() -> int:
    log = get_logger(STEP_ID)
    cfg = load_config()
    paths = get_paths()

    api_cfg = (cfg.get("api") or {}).get("siliconflow") or {}
    pipe_cfg = (cfg.get("pipeline") or {}).get("step01_convert_docs") or {}

    api_key = api_cfg.get("key") or ""
    if api_key.startswith("${") and api_key.endswith("}"):
        log.error(
            "未配置 SiliconFlow API Key。请在 config.yaml 中填写 api.siliconflow.key，"
            f"或将 {api_key} 对应的环境变量写入系统。"
        )
        return 10
    base_url = (api_cfg.get("base_url") or "https://api.siliconflow.cn/v1").rstrip("/")
    endpoint = f"{base_url}/chat/completions"

    model = pipe_cfg.get("model") or api_cfg.get("default_model") or "deepseek-ai/DeepSeek-V3.2"
    concurrency = int(pipe_cfg.get("max_workers") or 2)
    max_retries = int(pipe_cfg.get("max_retries") or 5)

    input_root = paths.input_archives
    output_root = paths.output_markdown
    progress_path = paths.output_logs / "step01_progress.json"

    log.info("=" * 70)
    log.info("Step 01 | DOCX → Markdown")
    log.info(f"  模型: {model}")
    log.info(f"  并发: {concurrency}  重试: {max_retries}")
    log.info(f"  输入: {input_root}")
    log.info(f"  输出: {output_root}")
    log.info("=" * 70)

    if not input_root.exists() or not any(input_root.iterdir()):
        log.error(f"输入目录为空: {input_root}")
        return 11

    tasks = collect_tasks(input_root, output_root)
    if not tasks:
        log.warning("未扫描到任何 .docx 文件")
        return 0

    log.info(f"扫描到文档总数: {len(tasks)}")

    will_skip = sum(
        1 for t in tasks
        if os.path.exists(t["output_path"])
        and os.path.getsize(t["output_path"]) >= MIN_VALID_SIZE
    )
    will_extract = len(tasks) - will_skip
    log.info(f"将跳过（已有有效md）: {will_skip}")
    log.info(f"将提取（缺失或无效）: {will_extract}")

    if will_extract == 0:
        log.info("所有文件均已提取，无需处理。")
        return 0

    progress = load_progress(progress_path)
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }

    semaphore = asyncio.Semaphore(concurrency)
    connector = aiohttp.TCPConnector(limit=concurrency + 2, ssl=False)
    async with aiohttp.ClientSession(connector=connector) as session:
        coros = [
            process_task(
                t, semaphore, session, endpoint, headers, model,
                max_retries, progress, progress_path, log,
            )
            for t in tasks
        ]
        results: list[bool] = []
        for coro in asyncio.as_completed(coros):
            try:
                ok = await coro
            except Exception as e:
                log.error(f"任务未捕获异常: {type(e).__name__}: {e}")
                ok = False
            results.append(ok)

    success = sum(1 for r in results if r)
    failed = sum(1 for r in results if not r)
    log.info("-" * 70)
    log.info(f"成功/跳过: {success}    失败: {failed}")
    if progress.get("failed"):
        log.info("失败文件（下次可重跑）：")
        for item in progress["failed"][:30]:
            log.info(f"  - {item}")
        if len(progress["failed"]) > 30:
            log.info(f"  …（共 {len(progress['failed'])} 个）")
    log.info("=" * 70)

    return 0 if failed == 0 else 1


def main() -> int:
    return asyncio.run(main_async())


if __name__ == "__main__":
    sys.exit(main())
