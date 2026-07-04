"""Relic management routes for the admin API."""
from __future__ import annotations

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Body, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import StreamingResponse

from data_loader import store  # noqa: E402
from services.admin_relic_service import (  # noqa: E402
    bulk_status_payload,
    bulk_update_payload,
    codes_payload,
    import_relic_items,
    iter_export_csv,
    normalize_relic_payload,
    parse_bbox,
    parse_import_items,
    split_csv_values,
)

router = APIRouter(tags=["??"])


# ── 文物 CRUD (DB + 乐观锁 + 审计) ────────────────────────
# 仅 DB 模式可用。调用方需传 expected_version,冲突返回 409。

def _require_db() -> None:
    if not getattr(store, "_use_db", False):
        raise HTTPException(503, "DB 未启用；请先运行 step07_build_db.py 并重启服务")


@router.post("/relics")
async def create_relic(
    payload: dict = Body(...),
    x_actor: Optional[str] = Header(None, alias="X-Actor"),
):
    """创建文物。payload 至少包含 code / name / lng / lat。"""
    _require_db()
    try:
        after = store.create_relic(normalize_relic_payload(payload), actor=x_actor or "")
    except ValueError as e:
        msg = str(e)
        code = 409 if "已存在" in msg else 400
        raise HTTPException(code, msg)
    return {"ok": True, "relic": after}


@router.put("/relics/{code}")
async def update_relic(
    code: str,
    payload: dict = Body(...),
    x_actor: Optional[str] = Header(None, alias="X-Actor"),
):
    """更新文物。payload 必传 expected_version;冲突返回 409。"""
    _require_db()
    ev = payload.pop("expected_version", None)
    if ev is None:
        raise HTTPException(400, "缺少 expected_version（乐观锁）")
    try:
        after = store.update_relic(
            code, normalize_relic_payload(payload),
            expected_version=int(ev), actor=x_actor or "",
        )
    except ValueError as e:
        msg = str(e)
        if msg == "VERSION_CONFLICT":
            raise HTTPException(409, "版本冲突：数据已被他人修改，请重新加载")
        if "不存在" in msg:
            raise HTTPException(404, msg)
        raise HTTPException(400, msg)
    return {"ok": True, "relic": after}


@router.delete("/relics/{code}")
async def delete_relic(
    code: str,
    x_actor: Optional[str] = Header(None, alias="X-Actor"),
):
    """软删除(status=-1)。可通过 PUT /relics/{code} 把 status 改回 1 恢复。"""
    _require_db()
    try:
        store.delete_relic(code, actor=x_actor or "")
    except ValueError as e:
        raise HTTPException(404, str(e))
    return {"ok": True}


@router.get("/audit")
async def list_audit(
    code: Optional[str] = None,
    limit: int = 100,
    action: Optional[str] = Query(None, description="多值逗号分隔：create,update,delete,rollback"),
    actor: Optional[str] = None,
    field: Optional[str] = Query(None, description="字段名 LIKE 过滤，如 'lng' / 'name'"),
    start_ts: Optional[int] = None,
    end_ts: Optional[int] = None,
):
    """审计日志列表,支持多条件筛选,最近在前。"""
    _require_db()
    actions = [a.strip() for a in (action or "").split(",") if a.strip()] or None
    return {
        "rows": store.list_audit(
            code=code, limit=max(1, min(limit, 500)),
            actions=actions,
            actor=(actor or "").strip() or None,
            field=(field or "").strip() or None,
            start_ts=start_ts, end_ts=end_ts,
        )
    }


@router.post("/audit/{audit_id}/rollback")
async def rollback_audit(
    audit_id: int,
    x_actor: Optional[str] = Header(None, alias="X-Actor"),
):
    """按审计记录回滚文物到 before_json 状态。"""
    _require_db()
    try:
        return store.rollback_audit(audit_id, actor=x_actor or "")
    except ValueError as e:
        msg = str(e)
        if msg == "VERSION_CONFLICT":
            raise HTTPException(409, "版本冲突：文物已被他人修改，请刷新后重试")
        if "不存在" in msg or "已彻底删除" in msg:
            raise HTTPException(404, msg)
        raise HTTPException(400, msg)


@router.get("/stats-overview")
async def stats_overview():
    """Dashboard 聚合指标,一次请求出齐所有卡片/图表数据;
    DB 未启用时走 legacy 内存聚合,仅返回基础字段。"""
    return store.admin_stats_overview()


@router.get("/codes")
async def codes_dict():
    """国标编码字典:category / rank / search_type → 中文标签。"""
    return codes_payload()


@router.get("/relics-townships")
async def relics_townships():
    """后台乡镇下拉,来源为 DB 中已入库文物。"""
    _require_db()
    return {"townships": store.admin_list_townships()}


@router.get("/relics")
async def list_relics(
    page: int = 1,
    size: int = 20,
    search: Optional[str] = None,
    category: Optional[str] = None,
    rank: Optional[str] = None,
    township: Optional[str] = None,
    search_type: Optional[str] = None,
    status: Optional[int] = None,
    bbox: Optional[str] = Query(None, description="minLng,minLat,maxLng,maxLat"),
    order_by: str = "updated_at_desc",
):
    """后台分页列表。category / rank 支持逗号多选。"""
    _require_db()
    categories = split_csv_values(category)
    ranks = split_csv_values(rank)
    return store.admin_list_relics(
        page=page, size=size, search=(search or "").strip() or None,
        categories=categories, ranks=ranks,
        township=(township or "").strip() or None,
        search_type=(search_type or "").strip() or None,
        status=status,
        bbox=parse_bbox(bbox),
        order_by=order_by,
    )


@router.get("/relics/{code}/neighbors")
async def relic_neighbors(
    code: str,
    radius: float = Query(2000.0, ge=50, le=50000, description="米"),
    limit: int = Query(20, ge=1, le=100),
):
    """radius 米内的其它文物,按距离升序。"""
    _require_db()
    return {
        "code": code, "radius": radius,
        "items": store.admin_neighbors(code, radius_m=radius, limit=limit),
    }


@router.get("/relics/{code}")
async def get_relic_full(code: str):
    """文物全字段,含 _version 供乐观锁。"""
    _require_db()
    r = store.get_relic_full(code) if hasattr(store, "get_relic_full") else store.get_relic(code)
    if not r:
        raise HTTPException(404, f"未找到文物: {code}")
    return r


@router.post("/relics/bulk-update")
async def bulk_update_relics(
    payload: dict = Body(...),
    x_actor: Optional[str] = Header(None, alias="X-Actor"),
):
    """批量同字段更新。payload = {codes, fields}。

    - fields 仅保留可写字段;不接受 expected_version(逐条取当前 version)。
    - 乐观锁冲突 / 不存在 / 异常逐条记录,不中断其它条目。
    """
    _require_db()
    try:
        codes, patch = bulk_update_payload(payload)
    except ValueError as e:
        raise HTTPException(400, str(e))
    try:
        return store.admin_bulk_update(codes, patch, actor=x_actor or "")
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/relics/bulk-status")
async def bulk_set_status(
    payload: dict = Body(...),
    x_actor: Optional[str] = Header(None, alias="X-Actor"),
):
    """批量改状态。payload = {codes, status}。status=-1 走软删(action=delete),
    0/1 走 bulk_update(action=update)。"""
    _require_db()
    try:
        codes, status = bulk_status_payload(payload)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if status == -1:
        return store.admin_bulk_delete(codes, actor=x_actor or "")
    return store.admin_bulk_update(codes, {"status": int(status)}, actor=x_actor or "")


@router.get("/relics-export")
async def export_relics(
    search: Optional[str] = None,
    category: Optional[str] = None,
    rank: Optional[str] = None,
    township: Optional[str] = None,
    search_type: Optional[str] = None,
    status: Optional[int] = None,
    codes: Optional[str] = Query(None, description="逗号分隔的 code 列表；给出时忽略其他筛选"),
    bbox: Optional[str] = Query(None, description="minLng,minLat,maxLng,maxLat"),
    order_by: str = "code_asc",
):
    """按筛选或显式 codes 列表导出 CSV(UTF-8 BOM,Excel 可直接打开)。"""
    _require_db()
    cat_list = split_csv_values(category)
    rank_list = split_csv_values(rank)
    code_list = split_csv_values(codes)

    def _gen():
        rows = store.admin_export_relics(
            search=(search or "").strip() or None,
            categories=cat_list, ranks=rank_list,
            township=(township or "").strip() or None,
            search_type=(search_type or "").strip() or None,
            status=status,
            codes=code_list,
            bbox=parse_bbox(bbox),
            order_by=order_by,
        )
        yield from iter_export_csv(rows)

    ts = datetime.now().strftime("%Y%m%d-%H%M%S")
    filename = f"relics-{ts}.csv"
    return StreamingResponse(
        _gen(),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


@router.post("/relics/import")
async def import_relics(
    file: UploadFile = File(...),
    mode: str = Form("upsert"),          # upsert / create_only
    x_actor: Optional[str] = Header(None, alias="X-Actor"),
):
    """批量导入。接受 CSV / JSON 数组,按 code 匹配。

    - upsert:已存在走 update(从 DB 读最新 version),否则 create
    - create_only:已存在则跳过,仅新增

    返回逐行结果。无整体事务;大文件请分批导入。
    """
    _require_db()
    raw = await file.read()
    try:
        items = parse_import_items(file.filename or "", raw)
    except ValueError as e:
        raise HTTPException(400, str(e))
    return import_relic_items(store, items, mode, actor=x_actor or "import")
