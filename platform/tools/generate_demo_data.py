"""生成演示数据集:济宁市在级文物保护单位(基础层) + 嘉祥县全量不可移动文物(全量层)。

    python platform/tools/generate_demo_data.py            # 生成
    python platform/tools/generate_demo_data.py --wipe     # 先清空 output 再生成

产出(直接写入 data/output,不经过 step01):
    dataset/relics_full.json         约 1370 条(基础层 804 + 嘉祥全量 568)
    dataset/relics_points.geojson
    dataset/relics_polygons.geojson  在级单位的两线范围面(演示用八边形缓冲)
    dataset/photo_index.csv + photos/{code}/*.jpg  占位照片
    data/templates/relics_import_template.csv      真实数据导入模板(仅表头)

之后运行 `python platform/scripts/run_pipeline.py --only 03` 灌库。

说明:
- 所有坐标、名称、状况均为演示虚构(少量知名文保单位使用公开的大致位置),
  data_source 请在 config.yaml 保持"演示数据"字样,替换真实数据后再修改。
- 级别构成:国保 41 / 省保 247 / 市保 260 / 县保 360,合计 908 处在级;
  嘉祥县 568 处 = 其在级 104 处 + 未定级 464 处,全部标记 tier=full。
"""
from __future__ import annotations

import argparse
import csv
import json
import math
import random
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from _common import get_paths  # noqa: E402
from codes import normalize_category, normalize_rank  # noqa: E402

random.seed(20260708)

# ── 行政区划(中心点 + 散布半径,单位度) ─────────────────────
COUNTIES: dict[str, dict] = {
    "任城区":  {"center": (116.595, 35.407), "r": 0.13, "weight": 9},
    "兖州区":  {"center": (116.828, 35.552), "r": 0.10, "weight": 6},
    "曲阜市":  {"center": (116.987, 35.581), "r": 0.13, "weight": 14},
    "邹城市":  {"center": (117.007, 35.402), "r": 0.16, "weight": 13},
    "微山县":  {"center": (117.129, 34.807), "r": 0.20, "weight": 7},
    "鱼台县":  {"center": (116.650, 35.012), "r": 0.10, "weight": 4},
    "金乡县":  {"center": (116.311, 35.066), "r": 0.11, "weight": 5},
    "嘉祥县":  {"center": (116.342, 35.408), "r": 0.13, "weight": 10},
    "汶上县":  {"center": (116.497, 35.732), "r": 0.11, "weight": 7},
    "泗水县":  {"center": (117.251, 35.664), "r": 0.14, "weight": 7},
    "梁山县":  {"center": (116.096, 35.802), "r": 0.12, "weight": 6},
}

COUNTY_CODE = {
    "任城区": "RC", "兖州区": "YZ", "曲阜市": "QF", "邹城市": "ZC",
    "微山县": "WS", "鱼台县": "YT", "金乡县": "JX2", "嘉祥县": "JX",
    "汶上县": "WSH", "泗水县": "SS", "梁山县": "LS",
}

JIAXIANG_TOWNSHIPS = [
    "嘉祥街道", "卧龙山街道", "万张街道", "梁宝寺镇", "疃里镇", "马村镇",
    "金屯镇", "大张楼镇", "老僧堂镇", "仲山镇", "满硐镇", "纸坊镇",
    "马集镇", "孟姑集镇", "黄垙镇",
]

GENERIC_TOWNSHIP_SUFFIX = ["镇", "镇", "镇", "街道", "乡"]

SURNAMES = ("王张李刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许韩冯邓曹彭曾"
            "肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石戴贾韦夏付方白邹孟熊秦邱侯江尹薛闫段雷龙黎史陶")

VILLAGE_MID = ["家", "官", "楼", "庄", "口", "桥", "集", "堂", "营", "屯", "坊", "台", "湾", "河", "山", ""]
VILLAGE_SUFFIX = ["村", "庄", "屯", "集", "楼", "堂"]

# 类别 → (名称模板, 年代池)
NAME_TEMPLATES: dict[str, list[str]] = {
    "古遗址": ["{v}遗址", "{v}故城遗址", "{v}窑址", "{v}文化遗址", "{v}城址"],
    "古墓葬": ["{v}墓群", "{v}汉墓群", "{s}氏家族墓", "{v}古墓", "{s}家林"],
    "古建筑": ["{s}氏祠堂", "{v}关帝庙", "{v}观音堂", "{v}三官庙", "{v}泰山行宫", "{s}家大院", "{v}古桥", "{v}清真寺"],
    "石窟寺及石刻": ["{v}石刻", "{v}摩崖造像", "{s}氏墓碑", "{v}经幢", "{v}碑刻"],
    "近现代重要史迹及代表性建筑": ["{v}战斗遗址", "{s}氏故居", "{v}县委旧址", "{v}烈士墓", "{v}教堂", "{v}火车站旧址"],
}

ERA_POOLS: dict[str, list[str]] = {
    "古遗址": ["新石器时代", "龙山文化", "大汶口文化", "商", "周", "东周", "汉", "汉、唐", "宋"],
    "古墓葬": ["汉", "东汉", "西汉", "晋", "唐", "宋", "元", "明", "清"],
    "古建筑": ["元", "明", "明、清", "清", "清、民国"],
    "石窟寺及石刻": ["北魏", "东魏", "北齐", "唐", "宋", "金", "明", "清"],
    "近现代重要史迹及代表性建筑": ["民国", "1938年", "1945年", "1948年", "1952年"],
}

CATEGORY_WEIGHTS = [
    ("古遗址", 30), ("古墓葬", 22), ("古建筑", 26),
    ("石窟寺及石刻", 10), ("近现代重要史迹及代表性建筑", 12),
]

CONDITION_WEIGHTS = [("好", 10), ("较好", 25), ("一般", 40), ("较差", 18), ("差", 7)]

# 知名文保单位(公开信息,坐标为大致位置,演示用)
FAMOUS: list[dict] = [
    dict(name="曲阜孔庙及孔府", county="曲阜市", cat="古建筑", era="金至清", lng=116.9866, lat=35.5967, rank="国保", batch="第一批"),
    dict(name="孔林", county="曲阜市", cat="古墓葬", era="东周至清", lng=116.9847, lat=35.6231, rank="国保", batch="第一批"),
    dict(name="鲁国故城遗址", county="曲阜市", cat="古遗址", era="周至汉", lng=116.9930, lat=35.6010, rank="国保", batch="第一批"),
    dict(name="尼山孔庙和书院", county="曲阜市", cat="古建筑", era="明、清", lng=117.2050, lat=35.4890, rank="国保", batch="第六批"),
    dict(name="孟庙及孟府", county="邹城市", cat="古建筑", era="金至清", lng=116.9737, lat=35.3990, rank="国保", batch="第三批"),
    dict(name="铁山摩崖石刻", county="邹城市", cat="石窟寺及石刻", era="北周", lng=116.9580, lat=35.4160, rank="国保", batch="第三批"),
    dict(name="明鲁王墓", county="邹城市", cat="古墓葬", era="明", lng=117.0730, lat=35.4420, rank="国保", batch="第六批"),
    dict(name="武氏墓群石刻", county="嘉祥县", cat="石窟寺及石刻", era="东汉", lng=116.3690, lat=35.3430, rank="国保", batch="第一批"),
    dict(name="青山寺", county="嘉祥县", cat="古建筑", era="明、清", lng=116.2920, lat=35.3760, rank="国保", batch="第七批"),
    dict(name="曾庙", county="嘉祥县", cat="古建筑", era="明、清", lng=116.3280, lat=35.3190, rank="国保", batch="第六批"),
    dict(name="崇觉寺铁塔", county="任城区", cat="古建筑", era="北宋", lng=116.5930, lat=35.4110, rank="国保", batch="第三批"),
    dict(name="济宁东大寺", county="任城区", cat="古建筑", era="明、清", lng=116.5720, lat=35.4020, rank="国保", batch="第六批"),
    dict(name="太白楼", county="任城区", cat="古建筑", era="明", lng=116.5810, lat=35.4030, rank="省保", batch="第一批"),
    dict(name="兴隆塔", county="兖州区", cat="古建筑", era="北宋", lng=116.8330, lat=35.5540, rank="国保", batch="第七批"),
    dict(name="宝相寺塔(太子灵踪塔)", county="汶上县", cat="古建筑", era="北宋", lng=116.4890, lat=35.7330, rank="国保", batch="第七批"),
    dict(name="光善寺塔", county="金乡县", cat="古建筑", era="唐", lng=116.3110, lat=35.0680, rank="省保", batch="第二批"),
    dict(name="伏羲庙", county="微山县", cat="古建筑", era="宋至清", lng=117.0690, lat=35.0220, rank="省保", batch="第三批"),
    dict(name="梁山青龙山摩崖", county="梁山县", cat="石窟寺及石刻", era="唐", lng=116.1010, lat=35.7940, rank="市保", batch="第二批"),
    dict(name="卞桥", county="泗水县", cat="古建筑", era="金", lng=117.3760, lat=35.7150, rank="国保", batch="第七批"),
    dict(name="旧城海子遗址", county="鱼台县", cat="古遗址", era="唐、宋", lng=116.6300, lat=34.9890, rank="省保", batch="第四批"),
]

RANK_BATCH = {
    "国保": ["第五批", "第六批", "第七批", "第八批"],
    "省保": ["第二批", "第三批", "第四批", "第五批"],
    "市保": ["第一批", "第二批", "第三批", "第四批"],
    "县保": ["第一批", "第二批", "第三批"],
}


def _pick_weighted(pairs: list[tuple[str, int]]) -> str:
    total = sum(w for _, w in pairs)
    x = random.uniform(0, total)
    acc = 0.0
    for v, w in pairs:
        acc += w
        if x <= acc:
            return v
    return pairs[-1][0]


def _village() -> str:
    s = random.choice(SURNAMES)
    mid = random.choice(VILLAGE_MID)
    suf = random.choice(VILLAGE_SUFFIX)
    name = f"{s}{mid}{suf}" if mid else f"{s}{suf}"
    return name


def _township_for(county: str) -> str:
    if county == "嘉祥县":
        return random.choice(JIAXIANG_TOWNSHIPS)
    s = random.choice(SURNAMES)
    style = random.choice(GENERIC_TOWNSHIP_SUFFIX)
    if style == "街道":
        return f"{s}桥{style}" if random.random() < 0.4 else f"{s}店{style}"
    return f"{s}{random.choice(['家', '集', '楼', '店', '桥', '村'])}{style}"


def _make_name(cat: str, village: str) -> str:
    tpl = random.choice(NAME_TEMPLATES[cat])
    return tpl.format(v=village.rstrip("村庄屯集楼堂"), s=random.choice(SURNAMES))


def _jitter_point(county: str) -> tuple[float, float]:
    c = COUNTIES[county]
    lng0, lat0 = c["center"]
    r = c["r"]
    ang = random.uniform(0, 2 * math.pi)
    dist = abs(random.gauss(0, r * 0.55))
    dist = min(dist, r)
    return (round(lng0 + dist * math.cos(ang), 6), round(lat0 + dist * math.sin(ang) * 0.85, 6))


def _octagon(lng: float, lat: float, radius_m: float) -> list[list[float]]:
    pts = []
    for i in range(8):
        a = math.pi / 8 + i * math.pi / 4
        dlng = radius_m * math.cos(a) / (111320.0 * math.cos(math.radians(lat)))
        dlat = radius_m * math.sin(a) / 110540.0
        pts.append([round(lng + dlng, 7), round(lat + dlat, 7)])
    pts.append(pts[0])
    return pts


def _brief(name: str, county: str, township: str, cat: str, era: str, cond: str) -> str:
    templates = [
        "{name}位于济宁市{county}{township}境内，为{era}时期{cat}。遗存本体保存{cond}，"
        "具有较高的历史、艺术和科学价值，是研究当地历史沿革与社会生活的重要实物资料。",
        "{name}地处{county}{township}，年代为{era}，属{cat}类不可移动文物。"
        "现状保存{cond}，周边环境总体稳定，已纳入日常巡查管理范围。",
        "{name}系{era}时期{cat}，坐落于{county}{township}。文物本体格局清晰，保存状况{cond}，"
        "对研究鲁西南地区{cat}的形制演变具有代表性意义。",
    ]
    return random.choice(templates).format(
        name=name, county=county, township=township, cat=cat, era=era, cond=cond)


def _protection_texts(name: str) -> tuple[str, str]:
    r1 = random.choice([30, 50, 60, 80, 100])
    r2 = r1 + random.choice([50, 100, 150])
    ps = f"以{name}本体外缘为基线，四周各外扩{r1}米。"
    cz = f"自保护范围边界线四周各外扩{r2}米，建控地带内新建建筑高度不得超过9米。"
    return ps, cz


def _last_patrol(cond: str) -> str:
    """按状况生成'上次巡查'日期(演示):状况越差越可能逾期。"""
    import datetime as dt
    days = {
        "差": random.randint(20, 120),
        "较差": random.randint(30, 150),
        "一般": random.randint(30, 200),
        "较好": random.randint(60, 300),
        "好": random.randint(60, 360),
    }[cond]
    return (dt.date.today() - dt.timedelta(days=days)).isoformat()


def _gen_units() -> tuple[list[dict], list[dict]]:
    """返回 (relics, polygon_features)。"""
    relics: list[dict] = []
    polys: list[dict] = []
    seq: dict[str, int] = {}

    def next_code(county: str) -> str:
        cc = COUNTY_CODE[county]
        seq[cc] = seq.get(cc, 0) + 1
        return f"JN-{cc}-{seq[cc]:04d}"

    def add(county: str, rank_zh: str, tier: str, *, famous: dict | None = None,
            force_cat: str | None = None) -> dict:
        if famous:
            cat = famous["cat"]
            name = famous["name"]
            lng, lat = famous["lng"], famous["lat"]
            era = famous["era"]
            township = _township_for(county)
            village = _village()
            batch = famous.get("batch", "")
        else:
            cat = force_cat or _pick_weighted(CATEGORY_WEIGHTS)
            village = _village()
            name = _make_name(cat, village)
            lng, lat = _jitter_point(county)
            era = random.choice(ERA_POOLS[cat])
            township = _township_for(county)
            batch = random.choice(RANK_BATCH.get(rank_zh, [""])) if rank_zh != "未定级" else ""

        cond = _pick_weighted(CONDITION_WEIGHTS)
        code = next_code(county)
        r = {
            "archive_code": code,
            "name": name,
            "category_main": cat,
            "category_code": normalize_category(cat),
            "heritage_level": {
                "国保": "全国重点文物保护单位", "省保": "省级文物保护单位",
                "市保": "市级文物保护单位", "县保": "县级文物保护单位",
                "未定级": "尚未核定公布为文物保护单位的不可移动文物",
            }[rank_zh],
            "rank_code": normalize_rank(rank_zh),
            "county": county,
            "township": township,
            "village": village,
            "address": f"济宁市{county}{township}{village}",
            "center_lng": lng,
            "center_lat": lat,
            "center_alt": round(random.uniform(35, 120), 1),
            "era": era,
            "era_stats": era.split("、")[0].split("至")[0],
            "condition_level": cond,
            "tier": tier,
            "intro": _brief(name, county, township, cat, era, cond),
            "ownership_type": random.choice(["国家所有", "集体所有", "集体所有", "私人所有"]),
            "last_patrol_at": _last_patrol(cond),
            "photo_count": 0,
            "drawing_count": 0,
            "has_3d": False,
            "has_archive_spu": False,
            "has_archive_fpu": False,
        }
        if batch:
            r["batch"] = f"{rank_zh}{batch}"

        if rank_zh != "未定级":
            ps, cz = _protection_texts(name)
            r["protection_scope"] = ps
            r["control_zone"] = cz
            r["has_boundary"] = True
            rad = random.choice([60, 80, 100, 120, 150])
            polys.append({
                "type": "Feature",
                "properties": {"archive_code": code, "kind": "protection", "name": name},
                "geometry": {"type": "Polygon", "coordinates": [_octagon(lng, lat, rad)]},
            })
            polys.append({
                "type": "Feature",
                "properties": {"archive_code": code, "kind": "control", "name": name},
                "geometry": {"type": "Polygon", "coordinates": [_octagon(lng, lat, rad * 2.1)]},
            })
        relics.append(r)
        return r

    # 1) 知名单位入库
    famous_by_county: dict[str, int] = {}
    for f in FAMOUS:
        tier = "full" if f["county"] == "嘉祥县" else "city"
        add(f["county"], f["rank"], tier, famous=f)
        famous_by_county[f["county"]] = famous_by_county.get(f["county"], 0) + 1

    # 2) 在级单位配额:国保 41 / 省保 247 / 市保 260 / 县保 360 = 908
    #    嘉祥县在级 104(国2 省12 市30 县60),其余按县区权重分摊。
    quota = {"国保": 41, "省保": 247, "市保": 260, "县保": 360}
    jiaxiang_quota = {"国保": 2, "省保": 12, "市保": 30, "县保": 60}
    famous_rank_count: dict[str, int] = {}
    for f in FAMOUS:
        famous_rank_count[f["rank"]] = famous_rank_count.get(f["rank"], 0) + 1
        if f["county"] == "嘉祥县":
            jiaxiang_quota[f["rank"]] -= 1

    other_counties = [c for c in COUNTIES if c != "嘉祥县"]
    weights = [COUNTIES[c]["weight"] for c in other_counties]

    for rank_zh, total in quota.items():
        remain = total - famous_rank_count.get(rank_zh, 0)
        jx_n = max(0, jiaxiang_quota.get(rank_zh, 0))
        for _ in range(jx_n):
            add("嘉祥县", rank_zh, "full")
        remain -= jx_n
        for _ in range(max(0, remain)):
            county = random.choices(other_counties, weights=weights, k=1)[0]
            add(county, rank_zh, "city")

    # 3) 嘉祥县未定级,补足全县 568 处
    jx_now = sum(1 for r in relics if r["county"] == "嘉祥县")
    for _ in range(max(0, 568 - jx_now)):
        add("嘉祥县", "未定级", "full")

    # 4) 嘉祥全量层扩展数据:三维模型约 400 个、三普/四普档案标记
    jx = [r for r in relics if r["county"] == "嘉祥县"]
    random.shuffle(jx)
    for i, r in enumerate(jx):
        r["has_archive_fpu"] = True                       # 四普档案全覆盖
        r["has_archive_spu"] = random.random() < 0.62     # 三普在册约六成
        if i < 400:
            r["has_3d"] = True

    return relics, polys


# ── 占位照片 ─────────────────────────────────────────────────
_CAT_COLOR = {
    "古遗址": (128, 106, 66), "古墓葬": (96, 84, 110), "古建筑": (150, 74, 58),
    "石窟寺及石刻": (90, 98, 105), "近现代重要史迹及代表性建筑": (70, 96, 88),
}

_FONT_CANDIDATES = [
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Light.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
]


def _load_font(size: int):
    from PIL import ImageFont
    for p in _FONT_CANDIDATES:
        if Path(p).exists():
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def _gen_photos(relics: list[dict], photos_dir: Path, index_csv: Path) -> None:
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print("[照片] 未安装 Pillow,跳过占位照片生成")
        return

    font_big = _load_font(40)
    font_small = _load_font(22)
    rows: list[dict] = []
    n_img = 0

    for r in relics:
        # 在级单位 2 张、未定级 1 张
        n = 2 if r["rank_code"] != "5" else 1
        code = r["archive_code"]
        color = _CAT_COLOR.get(r["category_main"], (100, 100, 100))
        for i in range(1, n + 1):
            rel = f"{code}/{i:02d}.jpg"
            dst = photos_dir / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            if not dst.exists():
                shade = tuple(min(255, c + (i - 1) * 25) for c in color)
                img = Image.new("RGB", (640, 428), shade)
                d = ImageDraw.Draw(img)
                d.rectangle([12, 12, 628, 416], outline=(255, 255, 255), width=2)
                d.text((32, 150), r["name"][:12], fill=(255, 255, 255), font=font_big)
                d.text((32, 220), f"{code} · 演示照片{i}", fill=(235, 235, 235), font=font_small)
                d.text((32, 260), f"{r['county']} {r['township']}", fill=(220, 220, 220), font=font_small)
                img.save(dst, "JPEG", quality=72)
                n_img += 1
            rows.append({"archive_code": code, "path": rel})
        r["photo_count"] = n

    with index_csv.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["archive_code", "path"])
        w.writeheader()
        w.writerows(rows)
    print(f"[照片] 新生成 {n_img} 张,索引 {len(rows)} 条")


def _gen_archive_docs(relics: list[dict], docs_dir: Path, max_units: int = 80) -> None:
    """给部分嘉祥全量层文物生成占位普查档案 PDF(sanpu/sipu),供档案查看功能演示。

    只生成前 max_units 处,避免演示包体积过大;has_archive_* 标记仍代表
    纸质档案在库情况,PDF 是其中已电子化的部分。
    """
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        print("[档案] 未安装 Pillow,跳过占位档案生成")
        return

    font_big = _load_font(36)
    font_small = _load_font(20)
    jx = [r for r in relics if r["tier"] == "full"][:max_units]
    n_pdf = 0

    for r in jx:
        code = r["archive_code"]
        kinds = ["sipu"] + (["sanpu"] if r.get("has_archive_spu") else [])
        for kind in kinds:
            dst = docs_dir / code / kind / f"{code}_{kind}.pdf"
            if dst.exists():
                n_pdf += 0
            else:
                dst.parent.mkdir(parents=True, exist_ok=True)
                label = "第三次全国文物普查档案" if kind == "sanpu" else "不可移动文物调查档案"
                img = Image.new("RGB", (595, 842), (248, 246, 240))
                d = ImageDraw.Draw(img)
                d.rectangle([28, 28, 567, 814], outline=(120, 110, 90), width=2)
                d.text((60, 120), label, fill=(60, 50, 40), font=font_big)
                d.text((60, 210), f"文物名称: {r['name']}", fill=(60, 50, 40), font=font_small)
                d.text((60, 250), f"档案编号: {code}", fill=(60, 50, 40), font=font_small)
                d.text((60, 290), f"所在地: {r['county']} {r['township']}", fill=(60, 50, 40), font=font_small)
                d.text((60, 330), f"级别: {r['heritage_level']}", fill=(60, 50, 40), font=font_small)
                d.text((60, 410), "(演示占位档案,实际部署时替换为电子化扫描件)", fill=(150, 140, 120), font=font_small)
                img.save(dst, "PDF", resolution=72)
                n_pdf += 1
    print(f"[档案] 占位 PDF 覆盖 {len(jx)} 处文物,新生成 {n_pdf} 份")


def _write_import_template(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    header = ["编号", "名称", "级别", "类别", "年代", "县区", "乡镇", "村", "地址",
              "经度", "纬度", "高程", "简介", "保存状况", "保护范围", "建设控制地带",
              "数据层级", "公布批次", "权属"]
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        csv.writer(f).writerow(header)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wipe", action="store_true", help="生成前清空 data/output 相关目录")
    args = ap.parse_args()

    paths = get_paths()
    if args.wipe:
        for d in (paths.output_dataset, paths.output_photos, paths.output_drawings):
            if d.exists():
                shutil.rmtree(d)
    paths.output_dataset.mkdir(parents=True, exist_ok=True)
    paths.output_photos.mkdir(parents=True, exist_ok=True)

    relics, polys = _gen_units()

    _gen_photos(relics, paths.output_photos, paths.output_dataset / "photo_index.csv")
    _gen_archive_docs(relics, paths.input_archive_docs)

    (paths.output_dataset / "relics_full.json").write_text(
        json.dumps(relics, ensure_ascii=False, indent=1), encoding="utf-8")

    pts = {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "geometry": {"type": "Point", "coordinates": [r["center_lng"], r["center_lat"]]},
                "properties": {"archive_code": r["archive_code"], "name": r["name"],
                               "heritage_level": r["heritage_level"], "county": r["county"]},
            }
            for r in relics
        ],
    }
    (paths.output_dataset / "relics_points.geojson").write_text(
        json.dumps(pts, ensure_ascii=False), encoding="utf-8")

    (paths.output_dataset / "relics_polygons.geojson").write_text(
        json.dumps({"type": "FeatureCollection", "features": polys}, ensure_ascii=False),
        encoding="utf-8")

    with (paths.output_dataset / "drawing_index.csv").open("w", encoding="utf-8-sig", newline="") as f:
        csv.DictWriter(f, fieldnames=["archive_code", "path"]).writeheader()

    _write_import_template(paths.root / "data" / "templates" / "relics_import_template.csv")

    n_city = sum(1 for r in relics if r["tier"] == "city")
    n_full = sum(1 for r in relics if r["tier"] == "full")
    n_jx3d = sum(1 for r in relics if r["has_3d"])
    by_rank: dict[str, int] = {}
    for r in relics:
        by_rank[r["heritage_level"]] = by_rank.get(r["heritage_level"], 0) + 1
    print(f"[演示数据] 共 {len(relics)} 条 (基础层 {n_city} / 嘉祥全量 {n_full},三维 {n_jx3d})")
    for k, v in by_rank.items():
        print(f"  - {k}: {v}")
    print("下一步: python platform/scripts/run_pipeline.py --only 03")
    return 0


if __name__ == "__main__":
    sys.exit(main())
