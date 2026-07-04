/**
 * 坐标转换工具 — TypeScript 镜像，与 platform/scripts/crs.py 算法一致。
 * 鼠标移动 / 浮窗显示等高频场景在前端跑，不打 API。
 *
 * 支持的 CRS:
 *   wgs84            : WGS84 经纬度 (°)
 *   cgcs2000         : CGCS2000 经纬度 (°), 默认 identity 近似
 *   cgcs2000_gk_3    : CGCS2000 高斯 3°带 (m)
 *   cgcs2000_gk_6    : CGCS2000 高斯 6°带 (m)
 *   gcj02            : 火星坐标 (°)
 *   bd09             : 百度坐标 (°)
 *   web_mercator     : Web Mercator (m)
 *
 * 顺序约定: 经纬度系一律 [lng, lat], 投影系一律 [x, y]。
 * 高斯 x 默认含带号 (例 38500000.0 表 38 带 / 中央 114°), 通过 zonePrefix 控制。
 */

export type CrsId =
  | "wgs84"
  | "cgcs2000"
  | "cgcs2000_gk_3"
  | "cgcs2000_gk_6"
  | "gcj02"
  | "bd09"
  | "web_mercator";

export interface CrsMeta {
  id: CrsId;
  name: string;
  unit: "degree" | "meter";
  axes: [string, string];
  category: "geographic" | "projected";
  description: string;
}

export const CRS_LIST: CrsMeta[] = [
  { id: "wgs84", name: "WGS84 经纬度", unit: "degree", axes: ["lng", "lat"], category: "geographic", description: "GPS / GeoJSON / 瓦片基准" },
  { id: "cgcs2000", name: "CGCS2000 经纬度", unit: "degree", axes: ["lng", "lat"], category: "geographic", description: "国家 2000 大地坐标系，工程上 ≈ WGS84" },
  { id: "cgcs2000_gk_3", name: "CGCS2000 高斯 3°带", unit: "meter", axes: ["x", "y"], category: "projected", description: "测绘行业主流" },
  { id: "cgcs2000_gk_6", name: "CGCS2000 高斯 6°带", unit: "meter", axes: ["x", "y"], category: "projected", description: "老规范" },
  { id: "gcj02", name: "GCJ-02 火星坐标", unit: "degree", axes: ["lng", "lat"], category: "geographic", description: "高德 / 腾讯" },
  { id: "bd09", name: "BD-09 百度坐标", unit: "degree", axes: ["lng", "lat"], category: "geographic", description: "百度地图" },
  { id: "web_mercator", name: "Web Mercator (3857)", unit: "meter", axes: ["x", "y"], category: "projected", description: "瓦片底图" },
];

export const CRS_MAP: Record<CrsId, CrsMeta> = Object.fromEntries(
  CRS_LIST.map((c) => [c.id, c]),
) as Record<CrsId, CrsMeta>;

// ── 椭球参数 (CGCS2000) ──────────────────────────────────────
const A = 6378137.0;
const F = 1 / 298.257222101;
const B = A * (1 - F);
const E2 = (A * A - B * B) / (A * A);
const EP2 = (A * A - B * B) / (B * B);

// ── GCJ-02 ────────────────────────────────────────────────────
const GCJ_A = 6378245.0;
const GCJ_EE = 0.00669342162296594323;

function inChina(lng: number, lat: number): boolean {
  return lng >= 72.004 && lng <= 137.8347 && lat >= 0.8293 && lat <= 55.8271;
}

function gcjDelta(lng: number, lat: number): [number, number] {
  const x = lng - 105.0;
  const y = lat - 35.0;
  let dLat =
    -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
    + ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0
    + ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0
    + ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320.0 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  let dLng =
    300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
    + ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0
    + ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0
    + ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x / 30.0) * Math.PI)) * 2.0) / 3.0;
  const radLat = (lat / 180.0) * Math.PI;
  const magic = 1 - GCJ_EE * Math.sin(radLat) ** 2;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI);
  dLng = (dLng * 180.0) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [dLng, dLat];
}

export function wgs84ToGcj02(lng: number, lat: number): [number, number] {
  if (!inChina(lng, lat)) return [lng, lat];
  const [dLng, dLat] = gcjDelta(lng, lat);
  return [lng + dLng, lat + dLat];
}

export function gcj02ToWgs84(lng: number, lat: number): [number, number] {
  if (!inChina(lng, lat)) return [lng, lat];
  const [dLng, dLat] = gcjDelta(lng, lat);
  return [lng - dLng, lat - dLat];
}

// ── BD-09 (经 GCJ02 中转) ─────────────────────────────────────
const BD_X_PI = (Math.PI * 3000.0) / 180.0;

function gcj02ToBd09(lng: number, lat: number): [number, number] {
  const z = Math.sqrt(lng * lng + lat * lat) + 0.00002 * Math.sin(lat * BD_X_PI);
  const theta = Math.atan2(lat, lng) + 0.000003 * Math.cos(lng * BD_X_PI);
  return [z * Math.cos(theta) + 0.0065, z * Math.sin(theta) + 0.006];
}

function bd09ToGcj02(lng: number, lat: number): [number, number] {
  const x = lng - 0.0065;
  const y = lat - 0.006;
  const z = Math.sqrt(x * x + y * y) - 0.00002 * Math.sin(y * BD_X_PI);
  const theta = Math.atan2(y, x) - 0.000003 * Math.cos(x * BD_X_PI);
  return [z * Math.cos(theta), z * Math.sin(theta)];
}

export function wgs84ToBd09(lng: number, lat: number): [number, number] {
  return gcj02ToBd09(...wgs84ToGcj02(lng, lat));
}

export function bd09ToWgs84(lng: number, lat: number): [number, number] {
  return gcj02ToWgs84(...bd09ToGcj02(lng, lat));
}

// ── Web Mercator ─────────────────────────────────────────────
const WM_R = 6378137.0;
const WM_LIMIT = 85.05112878;

export function wgs84ToWebMercator(lng: number, lat: number): [number, number] {
  const latC = Math.max(Math.min(lat, WM_LIMIT), -WM_LIMIT);
  return [
    (lng * Math.PI * WM_R) / 180,
    Math.log(Math.tan(Math.PI / 4 + (latC * Math.PI) / 360)) * WM_R,
  ];
}

export function webMercatorToWgs84(x: number, y: number): [number, number] {
  return [
    (x / WM_R) * (180 / Math.PI),
    (2 * Math.atan(Math.exp(y / WM_R)) - Math.PI / 2) * (180 / Math.PI),
  ];
}

// ── CGCS2000 ↔ WGS84 (默认 identity) ─────────────────────────
// 如需 cm 级精度, 调用 setHelmertParams 注入 7 参; 鼠标 readout 走前端足够.
let HELMERT: {
  dx: number; dy: number; dz: number;
  rx: number; ry: number; rz: number; ds: number;
} | null = null;

export function setHelmertParams(p: typeof HELMERT): void {
  HELMERT = p;
}

function llhToXyz(lng: number, lat: number, h = 0): [number, number, number] {
  const lr = (lng * Math.PI) / 180;
  const fr = (lat * Math.PI) / 180;
  const sf = Math.sin(fr);
  const cf = Math.cos(fr);
  const N = A / Math.sqrt(1 - E2 * sf * sf);
  return [
    (N + h) * cf * Math.cos(lr),
    (N + h) * cf * Math.sin(lr),
    (N * (1 - E2) + h) * sf,
  ];
}

function xyzToLlh(x: number, y: number, z: number): [number, number] {
  const lng = Math.atan2(y, x);
  const p = Math.sqrt(x * x + y * y);
  let lat = Math.atan2(z, p * (1 - E2));
  for (let i = 0; i < 8; i++) {
    const sf = Math.sin(lat);
    const N = A / Math.sqrt(1 - E2 * sf * sf);
    const h = p / Math.cos(lat) - N;
    const next = Math.atan2(z, p * (1 - (E2 * N) / (N + h)));
    if (Math.abs(next - lat) < 1e-12) {
      lat = next;
      break;
    }
    lat = next;
  }
  return [(lng * 180) / Math.PI, (lat * 180) / Math.PI];
}

function helmertApply(x: number, y: number, z: number, inverse = false): [number, number, number] {
  if (!HELMERT) return [x, y, z];
  const SEC = Math.PI / 648000.0;
  const sign = inverse ? -1 : 1;
  const rx = HELMERT.rx * SEC;
  const ry = HELMERT.ry * SEC;
  const rz = HELMERT.rz * SEC;
  const s = 1 + sign * HELMERT.ds * 1e-6;
  const x2 = sign * HELMERT.dx + s * (x + sign * (-rz * y + ry * z));
  const y2 = sign * HELMERT.dy + s * (sign * rz * x + y + sign * (-rx * z));
  const z2 = sign * HELMERT.dz + s * (sign * -ry * x + sign * rx * y + z);
  return [x2, y2, z2];
}

export function wgs84ToCgcs2000(lng: number, lat: number): [number, number] {
  if (!HELMERT) return [lng, lat];
  const [x, y, z] = llhToXyz(lng, lat);
  const [x2, y2, z2] = helmertApply(x, y, z, true);
  return xyzToLlh(x2, y2, z2);
}

export function cgcs2000ToWgs84(lng: number, lat: number): [number, number] {
  if (!HELMERT) return [lng, lat];
  const [x, y, z] = llhToXyz(lng, lat);
  const [x2, y2, z2] = helmertApply(x, y, z, false);
  return xyzToLlh(x2, y2, z2);
}

// ── 高斯-克吕格 ───────────────────────────────────────────────
export function gkZoneForLng(lng: number, zoneWidth: 3 | 6 = 3): number {
  if (zoneWidth === 6) return Math.floor(lng / 6) + 1;
  return Math.round(lng / 3);
}

export function gkCentralMeridian(zone: number, zoneWidth: 3 | 6 = 3): number {
  return zoneWidth === 6 ? zone * 6 - 3 : zone * 3;
}

export function gkForward(
  lng: number,
  lat: number,
  centralMeridian: number,
  opts: { zonePrefix?: boolean; zoneWidth?: 3 | 6 } = {},
): [number, number] {
  const { zonePrefix = true, zoneWidth = 3 } = opts;
  const lngR = (lng * Math.PI) / 180;
  const latR = (lat * Math.PI) / 180;
  const cmR = (centralMeridian * Math.PI) / 180;
  const L = lngR - cmR;

  const sf = Math.sin(latR);
  const cf = Math.cos(latR);
  const tf = Math.tan(latR);
  const N = A / Math.sqrt(1 - E2 * sf * sf);
  const T = tf * tf;
  const C = EP2 * cf * cf;
  const Aa = L * cf;

  const M = A * (
    (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256) * latR
    - ((3 * E2) / 8 + (3 * E2 ** 2) / 32 + (45 * E2 ** 3) / 1024) * Math.sin(2 * latR)
    + ((15 * E2 ** 2) / 256 + (45 * E2 ** 3) / 1024) * Math.sin(4 * latR)
    - ((35 * E2 ** 3) / 3072) * Math.sin(6 * latR)
  );

  const xLocal = N * (
    Aa
    + ((1 - T + C) * Aa ** 3) / 6
    + ((5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5) / 120
  );
  const y = M + N * tf * (
    (Aa * Aa) / 2
    + ((5 - T + 9 * C + 4 * C * C) * Aa ** 4) / 24
    + ((61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6) / 720
  );

  let x = xLocal + 500_000;
  if (zonePrefix) {
    const zone = zoneWidth === 6
      ? Math.round((centralMeridian + 3) / 6)
      : Math.round(centralMeridian / 3);
    x += zone * 1_000_000;
  }
  return [x, y];
}

export function gkInverse(
  x: number,
  y: number,
  centralMeridian: number,
  opts: { zonePrefix?: boolean } = {},
): [number, number] {
  const { zonePrefix = true } = opts;
  let xLocal: number;
  if (zonePrefix && x > 1_000_000) {
    const zone = Math.floor(x / 1_000_000);
    xLocal = x - zone * 1_000_000 - 500_000;
  } else {
    xLocal = x - 500_000;
  }
  const yLocal = y;

  const mu = yLocal / (A * (1 - E2 / 4 - (3 * E2 ** 2) / 64 - (5 * E2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const fp = mu
    + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu)
    + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu);
  const sf = Math.sin(fp);
  const cf = Math.cos(fp);
  const tf = Math.tan(fp);
  const N1 = A / Math.sqrt(1 - E2 * sf * sf);
  const T1 = tf * tf;
  const C1 = EP2 * cf * cf;
  const R1 = (A * (1 - E2)) / (1 - E2 * sf * sf) ** 1.5;
  const D = xLocal / N1;

  const lat = fp - ((N1 * tf) / R1) * (
    D ** 2 / 2
    - ((5 + 3 * T1 + 10 * C1 - 4 * C1 ** 2 - 9 * EP2) * D ** 4) / 24
    + ((61 + 90 * T1 + 298 * C1 + 45 * T1 ** 2 - 252 * EP2 - 3 * C1 ** 2) * D ** 6) / 720
  );
  const lng = (
    D
    - ((1 + 2 * T1 + C1) * D ** 3) / 6
    + ((5 - 2 * C1 + 28 * T1 - 3 * C1 ** 2 + 8 * EP2 + 24 * T1 ** 2) * D ** 5) / 120
  ) / cf;

  return [(lng * 180) / Math.PI + centralMeridian, (lat * 180) / Math.PI];
}

// ── 统一入口 transformPoint ───────────────────────────────────
export interface TransformOpts {
  centralMeridian?: number; // 仅 GK 用; 不传按经度自动选带
  zoneWidth?: 3 | 6;
  zonePrefix?: boolean;
}

function toWgs84(crs: CrsId, a: number, b: number, opts: TransformOpts): [number, number] {
  switch (crs) {
    case "wgs84": return [a, b];
    case "cgcs2000": return cgcs2000ToWgs84(a, b);
    case "gcj02": return gcj02ToWgs84(a, b);
    case "bd09": return bd09ToWgs84(a, b);
    case "web_mercator": return webMercatorToWgs84(a, b);
    case "cgcs2000_gk_3":
    case "cgcs2000_gk_6": {
      const zoneWidth = (crs === "cgcs2000_gk_3" ? 3 : 6) as 3 | 6;
      let cm = opts.centralMeridian;
      const zonePrefix = opts.zonePrefix !== false;
      if (cm === undefined) {
        if (zonePrefix && a > 1_000_000) {
          const zone = Math.floor(a / 1_000_000);
          cm = gkCentralMeridian(zone, zoneWidth);
        } else {
          throw new Error(`${crs} 反算需指定 centralMeridian 或带号前缀 x`);
        }
      }
      const [lng, lat] = gkInverse(a, b, cm, { zonePrefix });
      return cgcs2000ToWgs84(lng, lat);
    }
  }
}

function fromWgs84(crs: CrsId, lng: number, lat: number, opts: TransformOpts): [number, number] {
  switch (crs) {
    case "wgs84": return [lng, lat];
    case "cgcs2000": return wgs84ToCgcs2000(lng, lat);
    case "gcj02": return wgs84ToGcj02(lng, lat);
    case "bd09": return wgs84ToBd09(lng, lat);
    case "web_mercator": return wgs84ToWebMercator(lng, lat);
    case "cgcs2000_gk_3":
    case "cgcs2000_gk_6": {
      const zoneWidth = (crs === "cgcs2000_gk_3" ? 3 : 6) as 3 | 6;
      const [cLng, cLat] = wgs84ToCgcs2000(lng, lat);
      let cm = opts.centralMeridian;
      if (cm === undefined) {
        cm = gkCentralMeridian(gkZoneForLng(cLng, zoneWidth), zoneWidth);
      }
      return gkForward(cLng, cLat, cm, {
        zonePrefix: opts.zonePrefix !== false,
        zoneWidth,
      });
    }
  }
}

export function transformPoint(
  srcCrs: CrsId,
  dstCrs: CrsId,
  a: number,
  b: number,
  opts: TransformOpts = {},
): [number, number] {
  if (srcCrs === dstCrs) return [a, b];
  const [lng, lat] = toWgs84(srcCrs, a, b, opts);
  return fromWgs84(dstCrs, lng, lat, opts);
}

// ── 格式化助手 ────────────────────────────────────────────────
export function formatCoord(crs: CrsId, a: number, b: number): string {
  const meta = CRS_MAP[crs];
  if (meta.unit === "degree") {
    return `${a.toFixed(6)}°, ${b.toFixed(6)}°`;
  }
  return `${a.toFixed(2)}, ${b.toFixed(2)} m`;
}

/** 经纬度 → 度分秒字符串 (DMS), 例: 116°24'00.0"E */
export function toDms(lng: number, lat: number): { lng: string; lat: string } {
  const fmt = (v: number, pos: string, neg: string) => {
    const sign = v >= 0 ? pos : neg;
    const abs = Math.abs(v);
    const d = Math.floor(abs);
    const mFloat = (abs - d) * 60;
    const m = Math.floor(mFloat);
    const s = (mFloat - m) * 60;
    return `${d}°${m.toString().padStart(2, "0")}'${s.toFixed(2).padStart(5, "0")}"${sign}`;
  };
  return {
    lng: fmt(lng, "E", "W"),
    lat: fmt(lat, "N", "S"),
  };
}
