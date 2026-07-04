"""数据资源目录与开放共享 API。

- 目录项 = 平台沉淀的数据资产(基础台账、两线范围、媒体库、三维模型、巡查记录等),
  数量实时从 store / patrol_db 统计。
- 开放共享演示流程: 开放类可直接调 API;受限类提交申请 → 管理端审批。
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

_SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

from data_loader import store  # noqa: E402
from services.patrol_service import patrol_db  # noqa: E402

router = APIRouter(tags=["数据目录"])


def _datasets() -> list[dict]:
    relics = store.relics
    n_total = len(relics)
    n_designated = sum(1 for r in relics if (r.get("_rank_code") or "5") != "5")
    n_boundary = sum(1 for r in relics if r.get("has_boundary"))
    n_3d = sum(1 for r in relics if r.get("has_3d"))
    n_fpu = sum(1 for r in relics if r.get("has_archive_fpu"))
    n_records = len(patrol_db.list_records(limit=100000)) if patrol_db.ready else 0

    return [
        {
            "id": "relics_base",
            "name": "文物保护单位基础数据集",
            "desc": "全市国、省、市、县四级文物保护单位台账:名称、级别、类别、年代、坐标、简介、权属。",
            "category": "基础数据",
            "format": "JSON / CSV / API",
            "update_freq": "季度",
            "access": "open",
            "count": n_designated,
            "unit": "条",
            "api": "/api/relics/by-bbox",
        },
        {
            "id": "protection_zones",
            "name": "两线范围空间数据集",
            "desc": "在级文物保护单位的保护范围与建设控制地带矢量面,支持规划选址合规比对。",
            "category": "空间数据",
            "format": "GeoJSON / API",
            "update_freq": "随公布批次",
            "access": "apply",
            "count": n_boundary,
            "unit": "处",
            "api": "/api/relics/{code}/polygon",
        },
        {
            "id": "media_library",
            "name": "文物影像与图纸媒体库",
            "desc": "文物本体照片、测绘图纸等多媒体资料,用于展示传播与研究。",
            "category": "媒体数据",
            "format": "JPEG / PNG / PDF",
            "update_freq": "持续",
            "access": "apply",
            "count": len(store.photo_index) + len(store.drawing_index),
            "unit": "件",
            "api": "/api/relics/{code}/photos",
        },
        {
            "id": "models_3d",
            "name": "三维模型数据集(嘉祥全量层)",
            "desc": "嘉祥县不可移动文物实景三维模型,支持在线浏览与量测。",
            "category": "三维数据",
            "format": "3D Tiles / glTF",
            "update_freq": "年度",
            "access": "apply",
            "count": n_3d,
            "unit": "个",
            "api": "/3d/{code}/tileset.json",
        },
        {
            "id": "survey_archives",
            "name": "普查档案数据集(嘉祥全量层)",
            "desc": "嘉祥县不可移动文物三普/四普档案电子化成果,权限受控。",
            "category": "档案数据",
            "format": "PDF",
            "update_freq": "静态",
            "access": "restricted",
            "count": n_fpu,
            "unit": "卷",
            "api": "/api/relics/{code}/archives",
        },
        {
            "id": "patrol_records",
            "name": "文物巡查记录数据集",
            "desc": "基层巡查打卡记录:定位核验结果、现场照片、AI 保存状况评估,持续累积的动态数据。",
            "category": "动态数据",
            "format": "JSON / API",
            "update_freq": "实时",
            "access": "apply",
            "count": n_records,
            "unit": "条",
            "api": "/api/patrol/stats",
        },
        {
            "id": "stats_open",
            "name": "文物资源统计开放接口",
            "desc": "分级别/县区/类别/年代/保存状况的聚合统计,面向公众与研究机构开放。",
            "category": "统计数据",
            "format": "JSON API",
            "update_freq": "实时",
            "access": "open",
            "count": n_total,
            "unit": "条源数据",
            "api": "/api/stats/dashboard",
        },
    ]


@router.get("/catalog")
async def catalog():
    return {"datasets": _datasets(), "openapi_url": "/docs"}


class ApplyRequest(BaseModel):
    dataset_id: str
    applicant: str
    org: str = ""
    purpose: str = ""
    contact: str = ""


@router.post("/catalog/apply")
async def catalog_apply(body: ApplyRequest):
    ids = {d["id"] for d in _datasets()}
    if body.dataset_id not in ids:
        raise HTTPException(404, "数据集不存在")
    if not body.applicant.strip():
        raise HTTPException(400, "请填写申请人")
    if not patrol_db.ready:
        raise HTTPException(500, "业务库未初始化")
    conn = patrol_db._conn()
    cur = conn.execute(
        "INSERT INTO catalog_applications (dataset_id, applicant, org, purpose, contact, status, created_at) "
        "VALUES (?,?,?,?,?, 'pending', ?)",
        (body.dataset_id, body.applicant.strip(), body.org.strip(),
         body.purpose.strip(), body.contact.strip(), int(time.time())),
    )
    conn.commit()
    return {"ok": True, "id": cur.lastrowid, "status": "pending"}


@router.get("/catalog/applications")
async def catalog_applications(limit: int = 100):
    if not patrol_db.ready:
        return {"data": []}
    names = {d["id"]: d["name"] for d in _datasets()}
    rows = patrol_db._conn().execute(
        "SELECT * FROM catalog_applications ORDER BY id DESC LIMIT ?", (min(limit, 500),)
    ).fetchall()
    data = []
    for r in rows:
        item = {k: r[k] for k in r.keys()}
        item["dataset_name"] = names.get(item["dataset_id"], item["dataset_id"])
        data.append(item)
    return {"data": data}


class ReviewRequest(BaseModel):
    status: str  # approved / rejected
    reply: str = ""


@router.patch("/catalog/applications/{app_id}")
async def catalog_review(app_id: int, body: ReviewRequest):
    if body.status not in ("approved", "rejected"):
        raise HTTPException(400, "status 只能是 approved / rejected")
    if not patrol_db.ready:
        raise HTTPException(500, "业务库未初始化")
    conn = patrol_db._conn()
    cur = conn.execute(
        "UPDATE catalog_applications SET status = ?, reply = ?, reviewed_at = ? WHERE id = ?",
        (body.status, body.reply.strip(), int(time.time()), app_id),
    )
    conn.commit()
    if not cur.rowcount:
        raise HTTPException(404, "申请不存在")
    return {"ok": True}
