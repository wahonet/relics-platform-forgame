"""照片 EXIF GPS 解析(Pillow,无额外依赖)。

微信/手机相机直接拍摄的原图一般带 GPS;经过压缩转发的图可能丢失,
调用方应回退浏览器定位。
"""
from __future__ import annotations

import io
from typing import Optional


def _to_deg(values) -> Optional[float]:
    """EXIF 度分秒(IFDRational 三元组) → 十进制度。"""
    try:
        d = float(values[0])
        m = float(values[1])
        s = float(values[2])
        return d + m / 60.0 + s / 3600.0
    except (TypeError, ValueError, IndexError, ZeroDivisionError):
        return None


def extract_gps(image_bytes: bytes) -> dict:
    """返回 {lat, lng, taken_at} (任意项可为 None)。异常安全,永不抛错。"""
    out: dict = {"lat": None, "lng": None, "taken_at": None}
    try:
        from PIL import ExifTags, Image

        img = Image.open(io.BytesIO(image_bytes))
        exif = img.getexif()
        if not exif:
            return out

        # 拍摄时间
        dt = exif.get(0x0132) or exif.get(0x9003)
        if dt:
            out["taken_at"] = str(dt)

        gps_ifd = exif.get_ifd(ExifTags.IFD.GPSInfo)
        if not gps_ifd:
            return out

        lat = _to_deg(gps_ifd.get(2))   # GPSLatitude
        lng = _to_deg(gps_ifd.get(4))   # GPSLongitude
        lat_ref = str(gps_ifd.get(1) or "N")
        lng_ref = str(gps_ifd.get(3) or "E")
        if lat is not None and lat_ref.upper().startswith("S"):
            lat = -lat
        if lng is not None and lng_ref.upper().startswith("W"):
            lng = -lng
        out["lat"] = lat
        out["lng"] = lng
    except Exception:
        pass
    return out
