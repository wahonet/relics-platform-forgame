/**
 * 文物点位标识:按"类别选图形、级别定颜色"。
 *
 * 近距离(相机低于阈值)显示"徽章"图标:级别色圆形底 + 白色外圈 +
 * 白色类别剪影(icon/ 目录的五种符号,剪影内的细节线透出底色)。
 * 远距离(整市视角)退化为级别色圆点,避免几千个图标糊成一片。
 *
 *   国保=红  省保=橙  市保=蓝  县保=绿  未定级=紫
 */

/** 保护级别 → 颜色(与需求约定一致)。 */
export const RANK_COLOR: Record<string, string> = {
  "1": "#e63946", // 国保 红
  "2": "#f6892e", // 省保 橙
  "3": "#2f81f7", // 市保 蓝
  "4": "#2ea043", // 县保 绿
  "5": "#a45bf0", // 未定级 紫
};

/** 徽章模式:级别 → 图标像素尺寸(级别越高越醒目)。 */
export const RANK_BADGE_SIZE: Record<string, number> = {
  "1": 40,
  "2": 35,
  "3": 30,
  "4": 27,
  "5": 24,
};

/** 相机高于该高度(米)时用圆点,低于时用徽章图标。 */
export const ICON_MODE_MAX_HEIGHT = 40_000;

/** 类别编码 → 图标文件(由后端 /static/icons/ 提供)。 */
const CATEGORY_ICON_URL: Record<string, string> = {
  "0100": "/static/icons/yizhi.png",      // 古遗址
  "0200": "/static/icons/muzang.png",     // 古墓葬
  "0300": "/static/icons/gujian.png",     // 古建筑
  "0400": "/static/icons/beike.png",      // 石窟寺及石刻
  "0500": "/static/icons/jinxiandai.png", // 近现代
  "0600": "/static/icons/yizhi.png",      // 其他(无专属符号,复用遗址)
};

const TEXTURE_SIZE = 112;

let loadPromise: Promise<void> | null = null;
const baseImages = new Map<string, HTMLImageElement>();
const badgeCache = new Map<string, HTMLCanvasElement>();

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`icon load failed: ${url}`));
    img.src = url;
  });
}

/** 预载全部基础图标,幂等。 */
export function ensureIconsLoaded(): Promise<void> {
  if (!loadPromise) {
    loadPromise = Promise.all(
      [...new Set(Object.values(CATEGORY_ICON_URL))].map(async (url) => {
        baseImages.set(url, await loadImage(url));
      }),
    ).then(() => undefined);
  }
  return loadPromise;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 把原始图标(红色玻璃体 + 白色细节)转成"白色剪影 + 底色细节":
 * 彩色像素 → 白色;白色细节像素 → 底色,使符号内部结构仍可辨认。
 */
function silhouette(
  img: HTMLImageElement,
  size: number,
  detailColor: [number, number, number] | null,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, size, size);
  const data = ctx.getImageData(0, 0, size, size);
  const px = data.data;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] === 0) continue;
    const r = px[i], g = px[i + 1], b = px[i + 2];
    const sat = Math.max(r, g, b) - Math.min(r, g, b);
    if (sat > 24) {
      // 彩色玻璃体 → 白
      px[i] = 255; px[i + 1] = 255; px[i + 2] = 255;
    } else if (detailColor) {
      // 白色细节 → 底色,保留符号内部结构
      px[i] = detailColor[0]; px[i + 1] = detailColor[1]; px[i + 2] = detailColor[2];
    }
  }
  ctx.putImageData(data, 0, 0);
  return canvas;
}

/**
 * 生成徽章:级别色圆底 + 白色外圈 + 类别剪影。
 * 必须先 await ensureIconsLoaded(),未就绪时返回 null。
 */
export function getRelicBadge(category: string, rank: string): HTMLCanvasElement | null {
  const cat = CATEGORY_ICON_URL[category] ? category : "0600";
  const rk = RANK_COLOR[rank] ? rank : "5";
  const key = `${cat}_${rk}`;
  const cached = badgeCache.get(key);
  if (cached) return cached;
  const img = baseImages.get(CATEGORY_ICON_URL[cat]);
  if (!img) return null;

  const S = TEXTURE_SIZE;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d")!;
  const cx = S / 2;
  const ringW = S * 0.055;          // 白色外圈宽度
  const radius = S / 2 - ringW;     // 底色圆半径

  // 阴影让徽章从影像底图上"浮"出来
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.45)";
  ctx.shadowBlur = S * 0.06;
  ctx.beginPath();
  ctx.arc(cx, cx, radius, 0, Math.PI * 2);
  ctx.fillStyle = RANK_COLOR[rk];
  ctx.fill();
  ctx.restore();

  // 白色外圈
  ctx.beginPath();
  ctx.arc(cx, cx, radius, 0, Math.PI * 2);
  ctx.lineWidth = ringW;
  ctx.strokeStyle = "#ffffff";
  ctx.stroke();

  // 类别剪影居中(占圆的 ~62%)
  const iconSize = Math.round(S * 0.62);
  const sil = silhouette(img, iconSize, hexToRgb(RANK_COLOR[rk]));
  ctx.drawImage(sil, cx - iconSize / 2, cx - iconSize / 2);

  badgeCache.set(key, canvas);
  return canvas;
}

/** 图例用:白色剪影(细节透明),返回 dataURL。 */
export function categorySilhouetteUrl(category: string, size = 28): string | null {
  const url = CATEGORY_ICON_URL[category];
  const img = url ? baseImages.get(url) : null;
  if (!img) return null;
  return silhouette(img, size, null).toDataURL();
}

export function rankBadgeSize(rank: string): number {
  return RANK_BADGE_SIZE[rank] || RANK_BADGE_SIZE["5"];
}
