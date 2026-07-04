<template>
  <el-dialog
    :model-value="modelValue"
    title="地图框选"
    width="820px"
    top="6vh"
    :close-on-click-modal="false"
    append-to-body
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @opened="onOpened"
    @close="onClose"
  >
    <div class="bbox-wrap">
      <div class="bbox-hint">
        在地图上<b>按住左键拖拽</b>画矩形；松开自动完成。可再次拖拽重新绘制。
      </div>
      <div ref="mapEl" class="bbox-map" />
      <div class="bbox-layer-switch">
        <el-radio-group v-model="layer" size="small" @change="switchLayer">
          <el-radio-button value="sat">影像</el-radio-button>
          <el-radio-button value="osm">街道</el-radio-button>
        </el-radio-group>
      </div>

      <div class="bbox-info">
        <template v-if="current">
          <span class="mono">西南 {{ current[0].toFixed(6) }}, {{ current[1].toFixed(6) }}</span>
          <span class="sep">·</span>
          <span class="mono">东北 {{ current[2].toFixed(6) }}, {{ current[3].toFixed(6) }}</span>
          <span class="sep">·</span>
          <span class="muted">跨度 {{ spanKm.lng.toFixed(2) }} × {{ spanKm.lat.toFixed(2) }} km</span>
        </template>
        <template v-else>
          <span class="muted">尚未绘制矩形</span>
        </template>
      </div>
    </div>

    <template #footer>
      <div class="bbox-footer">
        <el-button :icon="Delete" @click="clearBbox">清空</el-button>
        <el-button @click="emit('update:modelValue', false)">取消</el-button>
        <el-button type="primary" :disabled="!current" @click="confirm">
          应用到筛选
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import L, { type LatLngBoundsExpression, type Map as LMap, type Rectangle, type TileLayer } from 'leaflet';
import { Delete } from '@element-plus/icons-vue';

const props = defineProps<{
  modelValue: boolean;
  initialBbox?: [number, number, number, number] | null;
  /** 地图视图的参考点(用于 fitBounds 或 setView) */
  points?: Array<{ lng: number | null; lat: number | null }>;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'confirm', bbox: [number, number, number, number]): void;
}>();

const mapEl = ref<HTMLDivElement>();
let map: LMap | null = null;
let base: TileLayer | null = null;
let rect: Rectangle | null = null;
const layer = ref<'sat' | 'osm'>('sat');

/** bbox 格式: [minLng, minLat, maxLng, maxLat] */
const current = ref<[number, number, number, number] | null>(null);

// 绘制状态。
let drawing = false;
let startLatLng: L.LatLng | null = null;

const spanKm = computed(() => {
  const b = current.value;
  if (!b) return { lng: 0, lat: 0 };
  const [mnl, mnt, mxl, mxt] = b;
  const avgLat = (mnt + mxt) / 2;
  const dLng = (mxl - mnl) * 111.32 * Math.cos((avgLat * Math.PI) / 180);
  const dLat = (mxt - mnt) * 110.57;
  return { lng: Math.abs(dLng), lat: Math.abs(dLat) };
});

function onOpened() {
  setTimeout(() => {
    ensureMap();
  }, 60);
}
function onClose() {
  destroyMap();
}

onBeforeUnmount(destroyMap);

function ensureMap() {
  if (map || !mapEl.value) return;
  map = L.map(mapEl.value, {
    zoomControl: true,
    attributionControl: false,
  });

  base = makeBase(layer.value);
  base.addTo(map);

  // 初始视图:initialBbox > points.fitBounds > 默认范围。
  if (props.initialBbox) {
    const [mnl, mnt, mxl, mxt] = props.initialBbox;
    current.value = [mnl, mnt, mxl, mxt];
    const b = L.latLngBounds([mnt, mnl], [mxt, mxl]);
    map.fitBounds(b, { padding: [20, 20] });
    rect = L.rectangle(b, rectStyle()).addTo(map);
  } else if (props.points && props.points.length) {
    const ll = props.points
      .filter((p): p is { lng: number; lat: number } =>
        typeof p.lng === 'number' && typeof p.lat === 'number',
      )
      .map((p) => L.latLng(p.lat, p.lng));
    if (ll.length) {
      const b = L.latLngBounds(ll).pad(0.1);
      map.fitBounds(b);
    } else {
      map.setView([32.0, 112.0], 9);
    }
  } else {
    map.setView([32.0, 112.0], 9);
  }

  bindDrawHandlers();
  setTimeout(() => map?.invalidateSize(), 80);
}

function destroyMap() {
  if (map) {
    try {
      map.remove();
    } catch { /* noop */ }
  }
  map = null;
  base = null;
  rect = null;
  drawing = false;
  startLatLng = null;
}

function rectStyle(): L.PathOptions {
  return {
    color: '#ff6b35',
    weight: 2,
    fillColor: '#ff6b35',
    fillOpacity: 0.12,
    dashArray: '4,4',
  };
}

function makeBase(kind: 'sat' | 'osm'): TileLayer {
  if (kind === 'osm') {
    return L.tileLayer('/tiles/osm/{z}/{x}/{y}.png', { maxZoom: 19 });
  }
  return L.tileLayer('/tiles/arcgis_sat/{z}/{y}/{x}', { maxZoom: 19 });
}

function switchLayer() {
  if (!map) return;
  if (base) {
    try { map.removeLayer(base); } catch { /* noop */ }
  }
  base = makeBase(layer.value);
  base.addTo(map);
}

function bindDrawHandlers() {
  if (!map) return;
  const container = map.getContainer();

  // 未按 Shift 也允许框选:按下瞬间禁用拖拽,松开恢复。
  const onDown = (ev: MouseEvent) => {
    if (ev.button !== 0) return;
    if (!map) return;
    drawing = true;
    const pt = map.mouseEventToLatLng(ev);
    startLatLng = pt;
    map.dragging.disable();
    if (rect) {
      try { rect.remove(); } catch { /* noop */ }
      rect = null;
    }
    rect = L.rectangle(L.latLngBounds(pt, pt), rectStyle()).addTo(map);
    container.style.cursor = 'crosshair';
    ev.preventDefault();
  };
  const onMove = (ev: MouseEvent) => {
    if (!drawing || !startLatLng || !map || !rect) return;
    const pt = map.mouseEventToLatLng(ev);
    const b = L.latLngBounds(startLatLng, pt);
    rect.setBounds(b as LatLngBoundsExpression);
  };
  const onUp = () => {
    if (!drawing) return;
    drawing = false;
    map?.dragging.enable();
    container.style.cursor = '';
    if (rect) {
      const b = rect.getBounds();
      const sw = b.getSouthWest();
      const ne = b.getNorthEast();
      // 忽略过小(误点)的矩形。
      if (Math.abs(ne.lng - sw.lng) < 1e-5 && Math.abs(ne.lat - sw.lat) < 1e-5) {
        try { rect.remove(); } catch { /* noop */ }
        rect = null;
        current.value = null;
        return;
      }
      current.value = [sw.lng, sw.lat, ne.lng, ne.lat];
    }
  };

  container.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);

  // 随 map.remove() 一起清理监听。
  map.on('unload', () => {
    container.removeEventListener('mousedown', onDown);
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', onUp);
  });
}

function clearBbox() {
  if (rect) {
    try { rect.remove(); } catch { /* noop */ }
    rect = null;
  }
  current.value = null;
}

function confirm() {
  if (!current.value) return;
  emit('confirm', current.value);
  emit('update:modelValue', false);
}
</script>

<style scoped>
.bbox-wrap {
  display: flex;
  flex-direction: column;
  gap: 10px;
  position: relative;
}
.bbox-hint {
  color: var(--el-text-color-regular);
  font-size: 13px;
}
.bbox-hint b { color: var(--el-color-primary); }
.bbox-map {
  width: 100%;
  height: 60vh;
  min-height: 400px;
  border-radius: 6px;
  border: 1px solid var(--el-border-color);
  background: #0d1117;
}
.bbox-layer-switch {
  position: absolute;
  top: 38px;
  right: 12px;
  z-index: 500;
}
.bbox-info {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: var(--el-fill-color-darker);
  border-radius: 6px;
  font-size: 12px;
  color: var(--el-text-color-regular);
}
.bbox-info .sep { color: var(--el-text-color-placeholder); }
.bbox-info .muted { color: var(--el-text-color-placeholder); }
.bbox-info .mono {
  font-family: var(--el-font-family-mono, ui-monospace, Menlo, Consolas, monospace);
}
.bbox-footer {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
</style>
