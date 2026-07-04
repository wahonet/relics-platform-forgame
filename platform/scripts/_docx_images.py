"""DOCX 图片提取公共工具,step03(照片)与 step04(图纸)共用。"""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


def sanitize_filename(name: str) -> str:
    return re.sub(r'[\/\\\:\*\?\"\<\>\|]', '_', name or '').strip()


def get_image_sequence_from_docx(docx_path: Path | str) -> list[str]:
    """解析 DOCX 底层 XML 获取图片出现顺序,返回 ZIP 内部路径列表。
    Word 中 `<w:drawing>` / `<w:pict>` 的引用顺序即为文档内图片顺序。"""
    images_ordered: list[str] = []
    with zipfile.ZipFile(str(docx_path), 'r') as z:
        rels_xml = z.read('word/_rels/document.xml.rels')
        rels_root = ET.fromstring(rels_xml)
        ns = {'rel': 'http://schemas.openxmlformats.org/package/2006/relationships'}
        rid_map: dict[str, str] = {}
        for rel in rels_root.findall('rel:Relationship', ns):
            rid = rel.get('Id')
            target = rel.get('Target') or ''
            if target.startswith('media/'):
                rid_map[rid] = f"word/{target}"
        doc_str = z.read('word/document.xml').decode('utf-8')
        rids = re.findall(r'r:embed="([^"]+)"', doc_str)
        rids += re.findall(r'r:id="([^"]+)"', doc_str)
        seen = set()
        for rid in rids:
            if rid in rid_map and rid not in seen:
                seen.add(rid)
                images_ordered.append(rid_map[rid])
    return images_ordered


TBL_ROW_RE = re.compile(r'\|(.*)\|')


def parse_md_list_tables(md_path: Path | str, section_names: set[str]) -> dict[str, list[dict]]:
    """抓取指定章节(如"图纸清单"/"照片清单")下的 Markdown 表格,
    返回 `{章节名: [{表头: 单元格值}]}`。"""
    result: dict[str, list[dict]] = {name: [] for name in section_names}

    with open(md_path, 'r', encoding='utf-8') as f:
        lines = f.readlines()

    current_section = ""
    headers: list[str] = []
    for line in lines:
        line = line.strip()
        if line.startswith('## '):
            current_section = line[3:].strip()
            headers = []
            continue
        if current_section not in section_names:
            continue
        if not line.startswith('|'):
            continue

        m = TBL_ROW_RE.match(line)
        if not m:
            continue
        cells = [c.strip() for c in m.group(1).split('|')]

        if '---' in cells[0] or '序号' in cells[0]:
            if '序号' in cells[0]:
                headers = cells
            continue

        if len(cells) >= len(headers) and cells[0]:
            row_data = dict(zip(headers, cells))
            result[current_section].append(row_data)

    return result


def find_docx_for_archive(
    archive_code: str,
    input_root: Path,
    md_parent_name: str,
) -> Path | None:
    """按档案编号定位源 DOCX。
    匹配优先级:同乡镇目录前缀 → 同乡镇目录包含 → 全树递归前缀。"""
    docx_dir = input_root / md_parent_name
    if docx_dir.is_dir():
        for f in docx_dir.iterdir():
            if not f.is_file() or f.suffix.lower() != ".docx":
                continue
            if f.name.startswith(archive_code):
                return f
        for f in docx_dir.iterdir():
            if not f.is_file() or f.suffix.lower() != ".docx":
                continue
            if archive_code in f.name:
                return f

    for f in input_root.rglob("*.docx"):
        if f.name.startswith(archive_code):
            return f
    return None
