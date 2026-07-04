"""Step 04 | DOCX → 图纸库 + 索引。

与 step03 同构,区别在于图纸总是排在 DOCX 图片流最前(偏移 = i)。

输出:
    data/output/drawings/<archive_code>/<archive_code>_<图号>_<名称>.ext
    data/output/dataset/drawing_index.{csv,json}
"""
from __future__ import annotations

import csv
import json
import os
import sys
import zipfile
from collections import defaultdict
from pathlib import Path

from _common import get_logger, get_paths, load_config
from _docx_images import (
    find_docx_for_archive,
    get_image_sequence_from_docx,
    parse_md_list_tables,
    sanitize_filename,
)

STEP_ID = "step04"


def load_csv_index(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open('r', encoding='utf-8-sig', newline='') as f:
        return list(csv.DictReader(f))


def merge_drawing_index(
    existing_rows: list[dict],
    new_by_code: dict[str, list[dict]],
    processed_codes: set[str],
) -> list[dict]:
    by_code_old: dict[str, list[dict]] = defaultdict(list)
    for row in existing_rows:
        code = (row.get("archive_code") or "").strip()
        if code:
            by_code_old[code].append(row)

    all_codes = set(by_code_old.keys()) | set(processed_codes)
    merged = []
    for code in sorted(all_codes):
        if code in processed_codes:
            merged.extend(new_by_code.get(code, []))
        else:
            merged.extend(by_code_old.get(code, []))

    deduped: dict[tuple, dict] = {}
    for row in merged:
        key = (
            (row.get("archive_code") or "").strip(),
            (row.get("relative_path") or "").strip(),
        )
        if not key[0]:
            continue
        deduped[key] = row
    out = list(deduped.values())
    out.sort(key=lambda r: (
        r.get("archive_code", ""),
        r.get("drawing_no", ""),
        r.get("relative_path", ""),
    ))
    return out


def main() -> int:
    log = get_logger(STEP_ID)
    cfg = load_config()
    paths = get_paths()

    pipe_cfg = (cfg.get("pipeline") or {}).get("step04_extract_drawings") or {}
    keep_existing = bool(pipe_cfg.get("skip_existing", True))

    input_root = paths.input_archives
    md_root = paths.output_markdown
    drawing_root = paths.output_drawings
    index_csv = paths.output_dataset / "drawing_index.csv"
    index_json = paths.output_dataset / "drawing_index.json"

    log.info("=" * 70)
    log.info("Step 04 | DOCX → 图纸库")
    log.info(f"  DOCX 源:  {input_root}")
    log.info(f"  Markdown: {md_root}")
    log.info(f"  输出到:   {drawing_root}")
    log.info("=" * 70)

    if not md_root.exists():
        log.error(f"未找到 Markdown 输出: {md_root}，请先运行 step01。")
        return 11
    if not input_root.exists():
        log.error(f"未找到 DOCX 源目录: {input_root}")
        return 11

    drawing_root.mkdir(parents=True, exist_ok=True)
    index_csv.parent.mkdir(parents=True, exist_ok=True)

    existing_rows = load_csv_index(index_csv)
    new_by_code: dict[str, list[dict]] = {}
    processed_codes: set[str] = set()

    total_mds = 0
    total_drawings = 0

    for md_path in md_root.rglob("*.md"):
        if md_path.name.endswith("_QC.md"):
            continue
        total_mds += 1

        archive_code = md_path.stem.split('_')[0]
        tables = parse_md_list_tables(md_path, {"图纸清单"})
        drawing_metadata = tables["图纸清单"]

        if not drawing_metadata:
            processed_codes.add(archive_code)
            new_by_code[archive_code] = []
            continue

        docx_path = find_docx_for_archive(
            archive_code, input_root, md_path.parent.name,
        )
        if docx_path is None:
            log.warning(f"未找到 {archive_code} 对应的原始 DOCX")
            processed_codes.add(archive_code)
            new_by_code[archive_code] = []
            continue

        try:
            images_in_docx = get_image_sequence_from_docx(docx_path)
        except Exception as e:
            log.error(f"解析 {docx_path.name} 失败: {e}")
            processed_codes.add(archive_code)
            new_by_code[archive_code] = []
            continue

        archive_dir = drawing_root / archive_code
        archive_dir.mkdir(parents=True, exist_ok=True)

        records_this: list[dict] = []
        with zipfile.ZipFile(str(docx_path), 'r') as docx_zip:
            for i, d_meta in enumerate(drawing_metadata):
                img_index = i
                if img_index >= len(images_in_docx):
                    log.warning(
                        f"{archive_code}: 图片数不足（需要第 {img_index + 1} 张，"
                        f"实际 {len(images_in_docx)} 张）"
                    )
                    break
                zip_img_path = images_in_docx[img_index]
                drawing_name = d_meta.get('名称', '未命名')
                safe_name = sanitize_filename(drawing_name)
                drawing_no = d_meta.get('图号', f'T{i + 1:03d}')
                ext = os.path.splitext(zip_img_path)[1].lower() or '.jpg'
                filename = f"{archive_code}_{drawing_no}_{safe_name}{ext}"
                save_path = archive_dir / filename
                relative_path = f"{archive_code}/{filename}"

                if keep_existing and save_path.exists() and save_path.stat().st_size > 0:
                    size_kb = round(save_path.stat().st_size / 1024, 2)
                else:
                    data = docx_zip.read(zip_img_path)
                    save_path.write_bytes(data)
                    size_kb = round(len(data) / 1024, 2)

                relic_name = ""
                parts = docx_path.stem.split('_', 1)
                if len(parts) >= 2:
                    relic_name = parts[1]

                records_this.append({
                    "archive_code": archive_code,
                    "relic_name": relic_name,
                    "drawing_code": d_meta.get('图纸编号', ''),
                    "drawing_no": drawing_no,
                    "drawing_name": drawing_name,
                    "scale": d_meta.get('比例', ''),
                    "drawer": d_meta.get('绘制人', ''),
                    "draw_date": d_meta.get('绘制时间', ''),
                    "relative_path": relative_path,
                    "file_size_kb": size_kb,
                    "extension": ext,
                })

        new_by_code[archive_code] = records_this
        processed_codes.add(archive_code)
        total_drawings += len(records_this)
        log.info(f"  [{archive_code}] 写入 {len(records_this)} 条（MD 列 {len(drawing_metadata)}）")

    all_index = merge_drawing_index(existing_rows, new_by_code, processed_codes)
    if all_index:
        keys = list(all_index[0].keys())
        with index_csv.open('w', encoding='utf-8-sig', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=keys)
            writer.writeheader()
            writer.writerows(all_index)
        index_json.write_text(
            json.dumps(all_index, ensure_ascii=False, indent=2),
            encoding='utf-8',
        )
        log.info("-" * 70)
        log.info(f"处理 MD 文件 {total_mds} 个，新提取图纸 {total_drawings} 张")
        log.info(f"索引总条数（合并去重后）: {len(all_index)}")
        log.info(f"  CSV:  {index_csv}")
        log.info(f"  JSON: {index_json}")
    else:
        log.warning("无索引数据，跳过写入。")

    return 0


if __name__ == "__main__":
    sys.exit(main())
