"""一键生成公开演示数据集,用于替换 `data/output/` 下的真实数据。

产物完全虚构:
- 1 个演示县(990101)、1 个示范街道、8 个虚构村
- 15 处不可移动文物,坐标落在 120.00~120.20E × 30.00~30.20N
- 所有人名均为角色代号("调查员A"等);档案编号使用 990101- 前缀

生成文件覆盖 markdown/dataset/boundaries 三大目录。
用法: `python platform/tools/generate_demo_data.py`。
"""
from __future__ import annotations

import csv
import json
import random
import shutil
from collections import Counter, defaultdict
from pathlib import Path

# ── 路径 ────────────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATA_OUTPUT = PROJECT_ROOT / "data" / "output"
MARKDOWN_DIR = DATA_OUTPUT / "markdown" / "01示范街道"
DATASET_DIR = DATA_OUTPUT / "dataset"
BY_TOWNSHIP_DIR = DATASET_DIR / "by_township"
BOUNDARIES_DIR = DATA_OUTPUT / "boundaries"
LOGS_DIR = DATA_OUTPUT / "logs"

# ── 配置 ────────────────────────────────────────────────────
# 固定 seed,保证复跑结果一致。
random.seed(20260421)

PROVINCE = "示范省"
CITY = "演示市"
COUNTY = "演示县"
COUNTY_CODE = "990101"
TOWNSHIP = "示范街道"
TOWNSHIP_CODE = "99010100"

# 虚构地理矩形
WEST, SOUTH = 120.000, 30.000
EAST, NORTH = 120.200, 30.200

# 8 个村按 4×2 网格切分街道范围。
VILLAGES = [
    {"name": "V01村", "col": 0, "row": 1},
    {"name": "V02村", "col": 1, "row": 1},
    {"name": "V03村", "col": 2, "row": 1},
    {"name": "V04村", "col": 3, "row": 1},
    {"name": "V05村", "col": 0, "row": 0},
    {"name": "V06村", "col": 1, "row": 0},
    {"name": "V07村", "col": 2, "row": 0},
    {"name": "V08村", "col": 3, "row": 0},
]

COL_W = (EAST - WEST) / 4  # 0.05°
ROW_H = (NORTH - SOUTH) / 2  # 0.10°


def village_bbox(v: dict) -> tuple[float, float, float, float]:
    w = WEST + v["col"] * COL_W
    s = SOUTH + v["row"] * ROW_H
    return w, s, w + COL_W, s + ROW_H


# ── 文物清单(15 条,覆盖六大类与不同保护级别) ───────────────
RELICS = [
    # (seq, village, sub_name, category_main, category_sub, era, era_stats, level, condition, area_m2, has_poly)
    ("0001", "V01村", "古窑址", "古遗址", "古窑址", "汉", "战汉", "", "较好", 360, True),
    ("0002", "V01村", "古井", "古建筑", "古井", "清", "清代", "", "一般", 3, False),
    ("0003", "V02村", "古墓群", "古墓葬", "普通墓葬", "明", "明代", "", "较差", 240, True),
    ("0004", "V02村", "石拱桥", "古建筑", "桥梁涵洞", "清", "清代", "县级文物保护单位", "一般", 48, False),
    ("0005", "V03村", "摩崖题刻", "石窟寺及石刻", "摩崖石刻", "唐", "隋唐", "", "较好", 6, False),
    ("0006", "V03村", "石棺墓", "古墓葬", "土墩墓", "宋", "宋代", "", "一般", 80, True),
    ("0007", "V04村", "文昌阁", "古建筑", "楼阁", "清", "清代", "市级文物保护单位", "一般", 120, True),
    ("0008", "V04村", "文昌阁碑", "石窟寺及石刻", "碑刻", "清", "清代", "", "较好", 2, False),
    ("0009", "V05村", "聚落遗址", "古遗址", "聚落址", "新石器时代", "新石器", "省级文物保护单位", "较差", 8600, True),
    ("0010", "V05村", "汉墓", "古墓葬", "封土墓", "汉", "战汉", "", "差", 180, False),
    ("0011", "V06村", "塔基遗址", "古遗址", "宗教遗址", "元", "元代", "", "一般", 55, False),
    ("0012", "V07村", "革命纪念碑", "近现代重要史迹及代表性建筑", "纪念建筑", "1949年", "近现代", "县级文物保护单位", "好", 36, False),
    ("0013", "V07村", "老民居", "近现代重要史迹及代表性建筑", "民居宅第", "民国", "近现代", "", "一般", 210, True),
    ("0014", "V08村", "石雕造像", "石窟寺及石刻", "石刻造像", "南北朝", "三国两晋南北朝", "", "较好", 4, False),
    ("0015", "V08村", "古树名木遗存", "其他", "古树名木", "民国", "近现代", "", "好", 1, False),
]

DEFAULT_LEVEL = "尚未核定公布为文物保护单位的不可移动文物"

# 虚构人员,统一使用角色代号。
SURVEYORS = ["调查员A", "调查员B", "调查员C", "调查员D", "调查员E"]
REVIEWER = "审核员A"
PHOTOGRAPHER = "摄影师A"
DRAFTER = "绘图员A"

# ── 文本模板（生成简介/备注） ───────────────────────────────
INTRO_TEMPLATE = (
    "{name}位于{prov}{city}{county}{township}{village}内，"
    "是一处{era_stats}时期的{cat_sub}，占地约{area}平方米。"
    "本条目为演示数据集中的{cat_main}类样本，"
    "用于展示平台的文物档案、三维地图与多维统计功能。"
    "{state_desc}"
    "2024年第四次全国文物普查对其进行了{survey_type}，"
    "数据真实与否不影响平台原型功能的体验。"
    "⚠️ 注意：本条目为公开仓库的演示数据，名称、坐标、简介均为随机生成，"
    "不对应任何真实文物。"
)

STATE_DESC_BY_COND = {
    "好": "文物本体保存状况良好，周边环境整洁，具备初步保护条件。",
    "较好": "文物本体基本完整，表面存在轻度风化痕迹，整体保存状况较好。",
    "一般": "文物本体存在一定程度的自然侵蚀与人为影响，需加强日常巡查。",
    "较差": "文物本体已出现明显病害，周边环境受生产活动影响，亟待保护。",
    "差": "文物本体损毁严重，部分结构缺失，存在较高的灭失风险。",
}

SURVEY_TYPES = ["复查", "新发现"]

REMARK_TEMPLATE = (
    "本条目数据由 generate_demo_data.py 在 {date} 随机生成，"
    "仅用于公开演示，不具备档案学意义。"
)

# 影响因素按保存现状选择。
RISK_FACTORS_POOL = {
    "好": "",
    "较好": "雨雪",
    "一般": "雨雪，生产生活活动",
    "较差": "雨雪，生产生活活动，其他因素",
    "差": "雨雪，生产生活活动，人为破坏，其他因素",
}

OWNERSHIP_BY_CAT = {
    "古遗址": ("国家所有", "", "{village}村民委员会", "{township}办事处", "农业"),
    "古墓葬": ("国家所有", "", "{village}村民委员会", "{township}办事处", "农业"),
    "古建筑": ("集体所有", "{village}村民委员会", "{village}村民委员会", "{township}办事处", "文化"),
    "石窟寺及石刻": ("集体所有", "{village}村民委员会", "{village}村民委员会", "{township}办事处", "文化"),
    "近现代重要史迹及代表性建筑": ("集体所有", "{village}村民委员会", "{village}村民委员会", "{township}办事处", "文化"),
    "其他": ("集体所有", "{village}村民委员会", "{village}村民委员会", "{township}办事处", "林业"),
}


# ── 坐标工具 ────────────────────────────────────────────────
def decimal_to_dms(value: float) -> str:
    """十进制度 → 度°分′秒″,秒保留 4 位小数。"""
    deg = int(value)
    remainder = (value - deg) * 60
    minute = int(remainder)
    second = (remainder - minute) * 60
    return f"{deg}°{minute}′{second:.4f}″"


def random_point_in(w: float, s: float, e: float, n: float, pad: float = 0.005) -> tuple[float, float]:
    lng = round(random.uniform(w + pad, e - pad), 8)
    lat = round(random.uniform(s + pad, n - pad), 8)
    return lng, lat


def build_polygon_around(center_lng: float, center_lat: float, area_m2: float) -> list[tuple[float, float]]:
    """根据面积估算近似正方形的 4 个角点。
    粗略换算:1° 纬度 ≈ 111 km,30°N 附近 1° 经度 ≈ 96 km。"""
    side_m = max(area_m2, 16) ** 0.5
    d_lat = side_m / 111320.0
    d_lng = side_m / 96600.0
    dx = d_lng / 2
    dy = d_lat / 2
    return [
        (round(center_lng - dx, 8), round(center_lat - dy, 8)),
        (round(center_lng + dx, 8), round(center_lat - dy, 8)),
        (round(center_lng + dx, 8), round(center_lat + dy, 8)),
        (round(center_lng - dx, 8), round(center_lat + dy, 8)),
    ]


# ── 构造完整 record ─────────────────────────────────────────
def build_records() -> list[dict]:
    records: list[dict] = []
    village_map = {v["name"]: v for v in VILLAGES}

    for idx, (seq, vil_name, sub, cat_main, cat_sub, era, era_stats, level_raw, cond, area, has_poly) in enumerate(RELICS):
        vil = village_map[vil_name]
        vw, vs, ve, vn = village_bbox(vil)
        center_lng, center_lat = random_point_in(vw, vs, ve, vn, pad=0.008)
        boundary_pts: list[dict] = []
        if has_poly:
            corners = build_polygon_around(center_lng, center_lat, area)
            for k, (lng, lat) in enumerate(corners):
                boundary_pts.append({
                    "type": "边界点",
                    "lat": lat,
                    "lng": lng,
                    "alt": 30.0,
                    "desc": f"边界{k + 1}",
                })

        archive_code = f"{COUNTY_CODE}-{seq}"
        name = f"{vil_name}{sub}"
        level = level_raw or DEFAULT_LEVEL

        ownership_type, owner_tpl, user_tpl, mgr_tpl, industry = OWNERSHIP_BY_CAT[cat_main]
        owner = owner_tpl.format(village=vil_name)
        user = user_tpl.format(village=vil_name)
        managing_org = mgr_tpl.format(township=TOWNSHIP)
        address = f"{PROVINCE}{CITY}{COUNTY}{TOWNSHIP}{vil_name}村内"

        survey_type = random.choice(SURVEY_TYPES)
        surveyors = "，".join(random.sample(SURVEYORS, k=random.randint(3, 5)))
        survey_date = f"2024.{random.randint(9, 11):02d}.{random.randint(1, 28):02d}"
        review_date = f"2025.{random.randint(1, 6):02d}.{random.randint(1, 28):02d}"

        risk_factors = RISK_FACTORS_POOL[cond]
        # 约半数条目有保护措施,制造差异化样本。
        prot_measures = random.choice(["", "", "围栏", "说明牌", "围栏、说明牌"])

        # 风险评分与 step02 保持一致。
        risk_map = {"差": 5, "较差": 4, "一般": 2, "较好": 1, "好": 0}
        risk_score = risk_map.get(cond, 0)
        if not prot_measures:
            risk_score += 3
        if "全国重点" in level:
            risk_score += 2
        elif "省级" in level:
            risk_score += 1

        has_prot_zone = "是" if "省级" in level or "市级" in level or "县级" in level else "否"
        has_ctrl_zone = "是" if "省级" in level else "否"

        drawing_count = 2
        photo_count = random.randint(4, 8)

        intro = INTRO_TEMPLATE.format(
            name=name,
            prov=PROVINCE,
            city=CITY,
            county=COUNTY,
            township=TOWNSHIP,
            village=vil_name,
            era_stats=era_stats,
            cat_sub=cat_sub,
            cat_main=cat_main,
            area=area,
            survey_type=survey_type,
            state_desc=STATE_DESC_BY_COND[cond],
        )
        remark = REMARK_TEMPLATE.format(date="2026-04-21")

        record = {
            "archive_code": archive_code,
            "name": name,
            "survey_type": survey_type,
            "category_main": cat_main,
            "category_sub": cat_sub,
            "era": era,
            "era_stats": era_stats,
            "heritage_level": level,
            "province": PROVINCE,
            "city": CITY,
            "county": COUNTY,
            "township": TOWNSHIP,
            "address": address,
            "center_lat": center_lat,
            "center_lng": center_lng,
            "center_alt": 30.0,
            "has_boundary": has_poly,
            "boundary_count": len(boundary_pts),
            "area": f"{area}平方米",
            "area_numeric": float(area),
            "prot_unit": "",
            "has_prot_zone": has_prot_zone,
            "has_ctrl_zone": has_ctrl_zone,
            "ownership_type": ownership_type,
            "owner": owner,
            "user": user,
            "managing_org": managing_org,
            "industry": industry,
            "is_open": "开放",
            "usage": random.choice(["无人使用", "开放参观", "农业生产"]),
            "is_relocated": "否",
            "is_changed": "否",
            "condition_level": cond,
            "prot_measures": prot_measures,
            "risk_factors": risk_factors,
            "audit_result": "资料翔实，数据准确，填写规范，符合要求。",
            "surveyors": surveyors,
            "survey_date": survey_date,
            "reviewer": REVIEWER,
            "review_date": review_date,
            "drawing_count": drawing_count,
            "photo_count": photo_count,
            "risk_score": risk_score,
            "intro": intro,
            "remark": remark,
            "has_3d": False,
            "model_3d_path": "",
            "source_file": f"{archive_code}_{name}_20260421120000.md",
            "_boundary_points": boundary_pts,
            "_village": vil_name,
        }
        records.append(record)
    return records


# ── Markdown 渲染 ───────────────────────────────────────────
MD_TEMPLATE = """# {name}

## 基本信息

| 字段 | 内容 |
|------|------|
| 档案编号 | {archive_code} |
| 普查性质 | {survey_type} |
| 文物大类 | {category_main} |
| 省份 | {province} |
| 地级市 | {city} |
| 县区 | {county} |
| 调查人 | {surveyors} |
| 调查日期 | {survey_date} |
| 审定人 | {reviewer} |
| 审定日期 | {review_date} |
| 抽查人 | （无） |
| 抽查日期 | （无） |

## 位置信息

| 字段 | 内容 |
|------|------|
| 详细地址 | {address} |
| 是否整体迁移 | {is_relocated} |
| 是否变更或消失 | {is_changed} |

## 坐标数据

| 序号 | 分组 | 测点类型 | 纬度 | 经度 | 海拔(m) | 测点说明 | 备注 |
|------|------|---------|------|------|---------|---------|------|
{coord_rows}

## 文物属性

| 字段 | 内容 |
|------|------|
| 总面积 | {area} |
| 文物级别 | {heritage_level} |
| 所属文物保护单位名称 | {prot_unit_display} |
| 已公布保护范围 | {has_prot_zone} |
| 已公布建设控制地带 | {has_ctrl_zone} |
| 年代 | {era} |
| 统计年代 | {era_stats} |
| 类别（大类） | {category_main} |
| 类别（细分） | {category_sub} |

## 权属与使用

| 字段 | 内容 |
|------|------|
| 所有权性质 | {ownership_type} |
| 产权单位或人 | {owner_display} |
| 使用单位或人 | {user_display} |
| 上级管理机构 | {managing_org} |
| 所属行业或系统 | {industry} |
| 开放状况 | {is_open} |
| 使用用途 | {usage} |

## 文物构成

### 本体文物

| 序号 | 分组 | 名称 | 类别 | 面积或数量 |
|------|------|------|------|-----------|
| 1 | （无） | {name}({category_main}) | （无） | {area}(1) |

### 附属文物

| 序号 | 分组 | 名称或类别 | 面积或数量 |
|------|------|-----------|-----------|
| （无） | （无） | （无） | （无） |

## 简介

{intro}

## 保存现状

| 字段 | 内容 |
|------|------|
| 现状评估 | {condition_level} |
| 已完成保护措施 | {prot_measures_display} |
| 主要影响因素 | {risk_factors_display} |

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
| 审核意见 | {audit_result} |
| 抽查结论 | （无） |

## 备注

{remark}

## 图纸清单

| 序号 | 图纸编号 | 图纸名称 | 图号 | 比例 | 绘制人 | 绘制时间 | 总页数 |
|------|---------|---------|------|------|------|---------|------|
| 1 | {archive_code}-T00001 | {name}地理位置图 | T001 | 1:20000 | {drafter} | 2025.06.20 | （无） |
| 2 | {archive_code}-T00002 | {name}平面示意图 | T002 | 1:1000 | {drafter} | 2025.06.20 | （无） |

## 照片清单

| 序号 | 照片编号 | 照片名称 | 照片号 | 摄影者 | 拍摄时间 | 拍摄方位 | 文字说明 | 总页数 |
|------|---------|---------|------|------|---------|---------|---------|------|
{photo_rows}
"""


def render_markdown(record: dict) -> str:
    def _or_none(value: str) -> str:
        return value if value else "（无）"

    coord_lines = []
    coord_idx = 1
    coord_lines.append(
        f"| {coord_idx} | （无） | 中心点 | "
        f"{decimal_to_dms(record['center_lat'])} | {decimal_to_dms(record['center_lng'])} | "
        f"{record['center_alt']} | 中心点 | （无） |"
    )
    coord_idx += 1
    for pt in record["_boundary_points"]:
        coord_lines.append(
            f"| {coord_idx} | （无） | 边界点 | "
            f"{decimal_to_dms(pt['lat'])} | {decimal_to_dms(pt['lng'])} | "
            f"{pt['alt']} | {pt['desc']} | （无） |"
        )
        coord_idx += 1

    photo_lines = []
    for i in range(1, record["photo_count"] + 1):
        photo_lines.append(
            f"| {i} | {record['archive_code']}-Z{i:05d} | {record['name']} | Z{i:03d} | "
            f"{PHOTOGRAPHER} | {record['survey_date']} | 由东向西 | 四普现状照片 | （无） |"
        )

    return MD_TEMPLATE.format(
        name=record["name"],
        archive_code=record["archive_code"],
        survey_type=record["survey_type"],
        category_main=record["category_main"],
        category_sub=record["category_sub"],
        province=record["province"],
        city=record["city"],
        county=record["county"],
        surveyors=record["surveyors"],
        survey_date=record["survey_date"],
        reviewer=record["reviewer"],
        review_date=record["review_date"],
        address=record["address"],
        is_relocated=record["is_relocated"],
        is_changed=record["is_changed"],
        coord_rows="\n".join(coord_lines),
        area=record["area"],
        heritage_level=record["heritage_level"],
        prot_unit_display=_or_none(record["prot_unit"]),
        has_prot_zone=record["has_prot_zone"],
        has_ctrl_zone=record["has_ctrl_zone"],
        era=record["era"],
        era_stats=record["era_stats"],
        ownership_type=record["ownership_type"],
        owner_display=_or_none(record["owner"]),
        user_display=_or_none(record["user"]),
        managing_org=record["managing_org"],
        industry=record["industry"],
        is_open=record["is_open"],
        usage=record["usage"],
        intro=record["intro"],
        condition_level=record["condition_level"],
        prot_measures_display=_or_none(record["prot_measures"]),
        risk_factors_display=_or_none(record["risk_factors"]),
        audit_result=record["audit_result"],
        remark=record["remark"],
        photo_rows="\n".join(photo_lines),
        drafter=DRAFTER,
    )


# ── Dataset 输出（对齐 step02 的 schema） ───────────────────
CSV_FIELDS = [
    "archive_code", "name", "survey_type",
    "category_main", "category_sub",
    "era", "era_stats", "heritage_level",
    "province", "city", "county", "township", "address",
    "center_lat", "center_lng", "center_alt",
    "has_boundary", "boundary_count",
    "area", "area_numeric",
    "prot_unit", "has_prot_zone", "has_ctrl_zone",
    "ownership_type", "owner", "user",
    "managing_org", "industry", "is_open", "usage",
    "is_relocated", "is_changed",
    "condition_level", "prot_measures", "risk_factors",
    "audit_result",
    "surveyors", "survey_date", "reviewer", "review_date",
    "drawing_count", "photo_count", "risk_score",
    "intro", "remark",
    "has_3d", "model_3d_path",
    "source_file",
]


def write_csv(path: Path, records: list[dict], fields: list[str] = CSV_FIELDS) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(records)


def write_json(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    clean = []
    for r in records:
        item = {k: v for k, v in r.items() if not k.startswith("_")}
        item["boundary_points"] = r.get("_boundary_points", [])
        clean.append(item)
    path.write_text(json.dumps(clean, ensure_ascii=False, indent=2), encoding="utf-8")


def write_points_geojson(path: Path, records: list[dict]) -> None:
    features = []
    for r in records:
        props = {k: v for k, v in r.items()
                 if not k.startswith("_") and k not in ("intro", "remark")}
        features.append({
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [r["center_lng"], r["center_lat"]]},
            "properties": props,
        })
    geojson = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": "EPSG:4326"}},
        "features": features,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(geojson, ensure_ascii=False, indent=2), encoding="utf-8")


def write_polygons_geojson(path: Path, records: list[dict]) -> None:
    features = []
    for r in records:
        pts = r.get("_boundary_points", [])
        if len(pts) < 3:
            continue
        ring = [[p["lng"], p["lat"]] for p in pts]
        ring.append(ring[0])
        props = {k: v for k, v in r.items()
                 if not k.startswith("_") and k not in ("intro", "remark")}
        features.append({
            "type": "Feature",
            "geometry": {"type": "Polygon", "coordinates": [ring]},
            "properties": props,
        })
    geojson = {
        "type": "FeatureCollection",
        "crs": {"type": "name", "properties": {"name": "EPSG:4326"}},
        "features": features,
    }
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(geojson, ensure_ascii=False, indent=2), encoding="utf-8")


def write_high_risk(path: Path, records: list[dict], top_n: int = 50) -> None:
    srt = sorted(records, key=lambda x: -x.get("risk_score", 0))
    top = srt[:top_n]
    fields = [
        "risk_score", "archive_code", "name", "township",
        "category_main", "era", "heritage_level",
        "condition_level", "prot_measures", "risk_factors",
        "ownership_type", "address",
    ]
    write_csv(path, top, fields)


def write_township_stats(path: Path, records: list[dict]) -> None:
    by_town: dict[str, list[dict]] = defaultdict(list)
    for r in records:
        by_town[r["township"]].append(r)

    cond_levels = ["好", "较好", "一般", "较差", "差"]
    cat_levels = [
        "古遗址", "古墓葬", "古建筑", "石窟寺及石刻",
        "近现代重要史迹及代表性建筑", "其他",
    ]

    rows = []
    for township, recs in sorted(by_town.items()):
        total = len(recs)
        cond_count = Counter(r["condition_level"] for r in recs)
        cat_count = Counter(r["category_main"] for r in recs)
        no_prot = sum(1 for r in recs if not r["prot_measures"])
        poor = sum(1 for r in recs if r["condition_level"] in ["较差", "差"])
        poor_no_prot = sum(
            1 for r in recs
            if r["condition_level"] in ["较差", "差"] and not r["prot_measures"]
        )
        has_coord = sum(1 for r in recs if r["center_lat"] is not None)
        row = {
            "乡镇": township, "文物总数": total, "有坐标": has_coord,
            "无保护措施": no_prot, "保存差或较差": poor,
            "高风险（差且无保护）": poor_no_prot,
        }
        for lv in cond_levels:
            row[f"现状_{lv}"] = cond_count.get(lv, 0)
        for cat in cat_levels:
            row[f"类别_{cat}"] = cat_count.get(cat, 0)
        rows.append(row)

    fields = (
        ["乡镇", "文物总数", "有坐标", "无保护措施", "保存差或较差", "高风险（差且无保护）"]
        + [f"现状_{lv}" for lv in cond_levels]
        + [f"类别_{cat}" for cat in cat_levels]
    )
    write_csv(path, rows, fields)


def write_category_stats(path: Path, records: list[dict]) -> None:
    rows = []
    total = len(records) or 1

    def _append(group: str, counter: Counter, missing_label: str) -> None:
        for val, cnt in counter.most_common():
            rows.append({
                "维度": group, "值": val or missing_label,
                "数量": cnt, "占比": f"{cnt / total * 100:.1f}%",
            })
        rows.append({"维度": "──", "值": "", "数量": "", "占比": ""})

    _append("文物大类", Counter(r["category_main"] for r in records), "未知")
    _append("统计年代", Counter(r["era_stats"] for r in records if r.get("era_stats")), "")
    _append("文物级别", Counter(r["heritage_level"] for r in records), "未填")
    _append("保存现状", Counter(r["condition_level"] for r in records), "未填")
    _append("所有权", Counter(r["ownership_type"] for r in records), "未填")

    write_csv(path, rows, ["维度", "值", "数量", "占比"])


def write_by_township(records: list[dict]) -> None:
    by_town: dict[str, list[dict]] = defaultdict(list)
    for r in records:
        by_town[r["township"]].append(r)
    for township, recs in sorted(by_town.items()):
        write_csv(BY_TOWNSHIP_DIR / f"{township}.csv", recs)
        write_json(BY_TOWNSHIP_DIR / f"{township}.json", recs)


# ── 行政边界 ────────────────────────────────────────────────
def build_rect_polygon(w: float, s: float, e: float, n: float) -> list[list[float]]:
    return [
        [round(w, 8), round(s, 8)],
        [round(e, 8), round(s, 8)],
        [round(e, 8), round(n, 8)],
        [round(w, 8), round(n, 8)],
        [round(w, 8), round(s, 8)],
    ]


def write_boundaries() -> None:
    BOUNDARIES_DIR.mkdir(parents=True, exist_ok=True)

    # 县边界:略大于街道。
    cw, cs, ce, cn = WEST - 0.01, SOUTH - 0.01, EAST + 0.01, NORTH + 0.01
    county_fc = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {
                "OBJECTID": 1,
                "XZQDM": COUNTY_CODE,
                "XZQMC": COUNTY,
                "DCMJ": round((ce - cw) * (cn - cs) * 111320 * 96600, 2),
                "BZ": "公开演示边界（非真实行政区划）",
            },
            "geometry": {"type": "Polygon", "coordinates": [build_rect_polygon(cw, cs, ce, cn)]},
        }],
    }
    (BOUNDARIES_DIR / "county.geojson").write_text(
        json.dumps(county_fc, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # 街道:整个 demo 矩形。
    township_fc = {
        "type": "FeatureCollection",
        "features": [{
            "type": "Feature",
            "properties": {
                "OBJECTID": 1,
                "XZQDM": TOWNSHIP_CODE,
                "XZQMC": TOWNSHIP,
                "DCMJ": round((EAST - WEST) * (NORTH - SOUTH) * 111320 * 96600, 2),
                "BZ": "公开演示边界（非真实行政区划）",
            },
            "geometry": {"type": "Polygon", "coordinates": [build_rect_polygon(WEST, SOUTH, EAST, NORTH)]},
        }],
    }
    (BOUNDARIES_DIR / "townships.geojson").write_text(
        json.dumps(township_fc, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    # 村边界:8 个网格,data_loader 依赖 ZLDWMC + _township 字段。
    village_features = []
    for i, v in enumerate(VILLAGES, start=1):
        vw, vs, ve, vn = village_bbox(v)
        village_features.append({
            "type": "Feature",
            "properties": {
                "OBJECTID": i,
                "ZLDWDM": f"{COUNTY_CODE}00{i:03d}0000",
                "ZLDWMC": v["name"],
                "DCMJ": round(COL_W * ROW_H * 111320 * 96600, 2),
                "_township": TOWNSHIP,
                "BZ": "公开演示边界（非真实行政区划）",
            },
            "geometry": {"type": "Polygon", "coordinates": [build_rect_polygon(vw, vs, ve, vn)]},
        })
    villages_fc = {"type": "FeatureCollection", "features": village_features}
    (BOUNDARIES_DIR / "villages.geojson").write_text(
        json.dumps(villages_fc, ensure_ascii=False, indent=2), encoding="utf-8"
    )


# ── 主流程 ──────────────────────────────────────────────────
def clean_previous_output() -> None:
    """清空 data/output/ 下的 step02 / step06 产物,保留目录骨架。"""
    targets = [
        DATA_OUTPUT / "markdown",
        DATASET_DIR,
        BOUNDARIES_DIR,
        LOGS_DIR,
    ]
    for d in targets:
        if d.exists():
            shutil.rmtree(d)


def main() -> int:
    print("=" * 60)
    print("  生成公开演示数据集 (完全虚构)")
    print("=" * 60)
    print(f"  项目根目录: {PROJECT_ROOT}")
    print(f"  虚构坐标范围: lng [{WEST}, {EAST}]  lat [{SOUTH}, {NORTH}]")
    print(f"  虚构行政: {PROVINCE} / {CITY} / {COUNTY} / {TOWNSHIP}")
    print(f"  村: {len(VILLAGES)} 个   文物: {len(RELICS)} 处")
    print("-" * 60)

    print("[1/4] 清理旧输出...")
    clean_previous_output()

    print("[2/4] 构造文物记录...")
    records = build_records()

    print("[3/4] 写 Markdown 档案...")
    MARKDOWN_DIR.mkdir(parents=True, exist_ok=True)
    for r in records:
        md_path = MARKDOWN_DIR / r["source_file"]
        md_path.write_text(render_markdown(r), encoding="utf-8")
    print(f"       共 {len(records)} 个 .md 文件 → {MARKDOWN_DIR}")

    print("[4/4] 写 dataset 与 boundaries...")
    write_csv(DATASET_DIR / "relics_master.csv", records)
    write_json(DATASET_DIR / "relics_full.json", records)
    write_points_geojson(DATASET_DIR / "relics_points.geojson", records)
    write_polygons_geojson(DATASET_DIR / "relics_polygons.geojson", records)
    write_by_township(records)
    write_high_risk(DATASET_DIR / "high_risk_relics.csv", records)
    write_township_stats(DATASET_DIR / "township_stats.csv", records)
    write_category_stats(DATASET_DIR / "category_stats.csv", records)
    write_boundaries()

    print("-" * 60)
    print("完成！")
    print(f"  markdown : {MARKDOWN_DIR}")
    print(f"  dataset  : {DATASET_DIR}")
    print(f"  bound..  : {BOUNDARIES_DIR}")
    print("提示：请把 config.yaml 的 project / geo.center / geo.bounds / "
          "administrative 同步为演示值，再启动平台体验。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
