"""一次性回填:把 Markdown 档案「文物构成 → 附属文物」解析进现有数据集。

背景:附属文物列(attachments)是后加字段。step01 重新导入时,在级文保
单位走 relics_full.json 权威基线,不会重读 Markdown;因此这里直接扫描
全部档案(主档案目录 + 全市未清洗目录),按档案编号把附属文物写回
relics_full.json,然后运行 step03_build_db.py 重建 relics.db 即可入库。

用法:
    python platform/scripts/backfill_attachments.py
    python platform/scripts/step03_build_db.py
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

from _common import get_logger, get_paths, load_config
from md_archive import get_field, parse_attachments

log = get_logger("backfill_attachments")

_CODE_RE = re.compile(r"\|\s*档案编号\s*\|")


def _scan_dir(root: Path, out: dict[str, str]) -> int:
    """解析目录下全部 .md,返回本目录新收集的附属文物条数。"""
    if not root.exists():
        return 0
    n = 0
    for p in sorted(root.rglob("*.md")):
        if p.name.endswith("_QC.md"):
            continue
        try:
            content = p.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        code = get_field(content, "基本信息", "档案编号")
        if not code:
            continue
        att = parse_attachments(content)
        if att and code not in out:
            out[code] = att
            n += 1
    return n


def main() -> int:
    paths = get_paths()
    cfg = load_config()

    att_by_code: dict[str, str] = {}
    n1 = _scan_dir(paths.input_markdown, att_by_code)
    log.info("主档案目录: %d 处有附属文物", n1)

    raw = str(
        (cfg.get("data_import") or {}).get("ungraded_markdown_dir")
        or "data/济宁市未清洗数据"
    ).strip()
    supplemental = Path(raw)
    if not supplemental.is_absolute():
        supplemental = paths.root / supplemental
    n2 = _scan_dir(supplemental, att_by_code)
    log.info("全市补充目录: 新增 %d 处(累计 %d)", n2, len(att_by_code))

    dataset = paths.output_dataset / "relics_full.json"
    if not dataset.exists():
        log.error("未找到 %s,请先运行 step01", dataset)
        return 2

    relics = json.loads(dataset.read_text(encoding="utf-8"))
    matched = 0
    for r in relics:
        code = str(r.get("archive_code") or "").strip()
        att = att_by_code.get(code, "")
        if att:
            matched += 1
        r["attachments"] = att
    dataset.write_text(json.dumps(relics, ensure_ascii=False, indent=1), encoding="utf-8")
    log.info("relics_full.json 已更新: %d / %d 条带附属文物", matched, len(relics))
    log.info("请运行 step03_build_db.py 重建 relics.db 使其入库")
    return 0


if __name__ == "__main__":
    sys.exit(main())
