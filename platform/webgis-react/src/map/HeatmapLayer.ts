/**
 * 文物密度热力图层。
 *
 * 纯前端实现:点集 → canvas 灰度累积(径向渐变) → 色带映射 →
 * 作为贴地矩形的半透明贴图叠加。无第三方依赖,千级点位毫秒级重绘。
 */
import * as Cesium from "cesium";

type LngLat = [number, number];

interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

const CANVAS_SIZE = 640;
/** 热力核半径(px,基于 CANVAS_SIZE 画布)。 */
const RADIUS = 26;
/** 单点强度(累积透明度),点越密叠加越亮。 */
const INTENSITY = 0.16;
/**
 * 热力面抬升高度(米)。贴地矩形属于地面分类图层,会被边界线/图斑等
 * 其他贴地要素盖住;抬到少量高度后按普通半透明面渲染,即可位于
 * 除文物点(关闭深度测试,始终置顶)以外的所有图层之上。
 * 30m 在市县尺度视角下与贴地在视觉上无差别。
 */
const LIFT_M = 30;

/** 色带:透明 → 蓝 → 青 → 绿 → 黄 → 红。 */
function buildGradient(): Uint8ClampedArray {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  const gradient = ctx.createLinearGradient(0, 0, 256, 0);
  gradient.addColorStop(0.0, "rgba(46, 111, 224, 0)");
  gradient.addColorStop(0.2, "rgba(46, 111, 224, 0.55)");
  gradient.addColorStop(0.4, "rgba(64, 196, 213, 0.65)");
  gradient.addColorStop(0.6, "rgba(94, 201, 106, 0.7)");
  gradient.addColorStop(0.8, "rgba(240, 197, 60, 0.78)");
  gradient.addColorStop(1.0, "rgba(235, 82, 62, 0.85)");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 1);
  return ctx.getImageData(0, 0, 256, 1).data;
}

function boundsOf(points: LngLat[]): Bounds | null {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity;
  points.forEach(([lng, lat]) => {
    west = Math.min(west, lng);
    south = Math.min(south, lat);
    east = Math.max(east, lng);
    north = Math.max(north, lat);
  });
  if (!Number.isFinite(west) || west >= east || south >= north) return null;
  const padLng = (east - west) * 0.12;
  const padLat = (north - south) * 0.12;
  return {
    west: west - padLng,
    south: south - padLat,
    east: east + padLng,
    north: north + padLat,
  };
}

export class HeatmapLayer {
  private viewer: Cesium.Viewer;
  private entity: Cesium.Entity | null = null;
  private gradient = buildGradient();
  private canvas: HTMLCanvasElement;

  constructor(viewer: Cesium.Viewer) {
    this.viewer = viewer;
    this.canvas = document.createElement("canvas");
    this.canvas.width = CANVAS_SIZE;
    this.canvas.height = CANVAS_SIZE;
  }

  /** 重绘热力(points 为空则清除)。 */
  update(points: LngLat[]): void {
    if (this.viewer.isDestroyed()) return;
    this.clear();
    const bounds = points.length >= 2 ? boundsOf(points) : null;
    if (!bounds) {
      this.viewer.scene.requestRender();
      return;
    }

    // 画布纵横比跟随地理范围(近似,市域尺度形变可忽略)
    const aspect = (bounds.east - bounds.west) / (bounds.north - bounds.south);
    const width = aspect >= 1 ? CANVAS_SIZE : Math.round(CANVAS_SIZE * aspect);
    const height = aspect >= 1 ? Math.round(CANVAS_SIZE / aspect) : CANVAS_SIZE;
    this.canvas.width = width;
    this.canvas.height = height;
    const ctx = this.canvas.getContext("2d")!;
    ctx.clearRect(0, 0, width, height);

    // pass 1: 灰度累积
    points.forEach(([lng, lat]) => {
      const x = ((lng - bounds.west) / (bounds.east - bounds.west)) * width;
      const y = (1 - (lat - bounds.south) / (bounds.north - bounds.south)) * height;
      const radial = ctx.createRadialGradient(x, y, 0, x, y, RADIUS);
      radial.addColorStop(0, `rgba(0, 0, 0, ${INTENSITY})`);
      radial.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = radial;
      ctx.fillRect(x - RADIUS, y - RADIUS, RADIUS * 2, RADIUS * 2);
    });

    // pass 2: 累积透明度 → 色带
    const image = ctx.getImageData(0, 0, width, height);
    const data = image.data;
    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3];
      if (alpha === 0) continue;
      const offset = Math.min(255, alpha) * 4;
      data[i] = this.gradient[offset];
      data[i + 1] = this.gradient[offset + 1];
      data[i + 2] = this.gradient[offset + 2];
      data[i + 3] = this.gradient[offset + 3];
    }
    ctx.putImageData(image, 0, 0);

    this.entity = this.viewer.entities.add({
      rectangle: {
        coordinates: Cesium.Rectangle.fromDegrees(
          bounds.west, bounds.south, bounds.east, bounds.north,
        ),
        height: LIFT_M,
        material: new Cesium.ImageMaterialProperty({
          image: this.canvas.toDataURL(),
          transparent: true,
        }),
      },
    });
    this.viewer.scene.requestRender();
  }

  clear(): void {
    if (this.entity && !this.viewer.isDestroyed()) {
      try {
        this.viewer.entities.remove(this.entity);
      } catch {
        /* ignore */
      }
    }
    this.entity = null;
  }

  destroy(): void {
    this.clear();
  }
}
