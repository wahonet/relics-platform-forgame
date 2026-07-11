"""文物数字名片 API(扫码分享用,免登录)。

GET /api/card/{code}          名片精简数据(名称/级别/位置/简介/照片)
GET /api/card/{code}/qr.png   名片页二维码(指向局域网可达地址)
"""
from __future__ import annotations

import io
from urllib.parse import quote

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from data_loader import store
from routers.patrol import _base_url

router = APIRouter(tags=["数字名片"])

MAX_CARD_PHOTOS = 3


@router.get("/card/{code}")
async def card_data(code: str):
    relic = store.get_relic_full(code) if store._use_db else store.get_relic(code)
    if not relic:
        raise HTTPException(404, f"文物 {code} 不存在")
    photos = [
        f"/photos/{quote(p.get('relative_path') or p.get('path') or '')}"
        for p in (store.get_photos(code) or [])[:MAX_CARD_PHOTOS]
        if p.get("relative_path") or p.get("path")
    ]
    return {
        "code": code,
        "name": relic.get("name") or "",
        "era": relic.get("era") or "",
        "category_main": relic.get("category_main") or "",
        "heritage_level": relic.get("heritage_level") or "",
        "county": relic.get("county") or "",
        "township": relic.get("township") or "",
        "address": relic.get("address") or "",
        "condition_level": relic.get("condition_level") or "",
        "intro": relic.get("intro") or "",
        "photos": photos,
    }


@router.get("/card/{code}/qr.png")
async def card_qr(code: str, request: Request):
    relic = store.get_relic(code)
    if not relic:
        raise HTTPException(404, f"文物 {code} 不存在")
    url = f"{_base_url(request)}/app/#/card/{code}"
    try:
        import qrcode
    except ImportError:
        raise HTTPException(500, "服务器未安装 qrcode 库: pip install qrcode[pil]")
    img = qrcode.make(url, box_size=8, border=2)
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return Response(
        content=buf.getvalue(),
        media_type="image/png",
        headers={"Cache-Control": "no-store", "X-Card-Url": quote(url, safe=":/#?&=")},
    )
