<template>
  <el-dialog
    :model-value="modelValue"
    :title="title"
    width="720px"
    :close-on-click-modal="false"
    append-to-body
    @close="handleClose"
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
  >
    <div v-if="loading" class="loading-block">
      <el-icon class="is-loading" :size="18"><Loading /></el-icon>
      加载中…
    </div>

    <el-form
      v-else
      ref="formRef"
      :model="form"
      :rules="rules"
      label-width="90px"
      label-position="right"
      @submit.prevent
    >
      <el-tabs v-model="activeTab" class="relic-tabs">
        <el-tab-pane label="基本信息" name="basic">
          <!-- 最近变更（仅编辑模式） -->
          <el-collapse v-if="isEdit && recentAudit.length" class="mini-audit">
            <el-collapse-item name="hist">
              <template #title>
                <span class="mini-audit-title">
                  <el-icon><Tickets /></el-icon>
                  最近变更（{{ recentAudit.length }}）
                  <el-link
                    type="primary"
                    class="mini-audit-more"
                    @click.stop="jumpFullHistory"
                  >
                    查看完整历史 →
                  </el-link>
                </span>
              </template>
              <el-timeline class="mini-audit-timeline">
                <el-timeline-item
                  v-for="r in recentAudit"
                  :key="r.id"
                  :timestamp="fmtAuditTs(r.ts)"
                  :type="auditDotType(r.action)"
                  :hollow="r.action === 'update'"
                >
                  <div class="audit-line">
                    <el-tag size="small" :type="auditDotType(r.action)" effect="plain">
                      {{ auditActionLabel(r.action) }}
                    </el-tag>
                    <span class="audit-actor">{{ r.actor || '-' }}</span>
                    <span class="audit-fields">{{ auditSummaryText(r) }}</span>
                  </div>
                </el-timeline-item>
              </el-timeline>
            </el-collapse-item>
          </el-collapse>

          <el-form-item label="文物编号" prop="code">
            <el-input
              v-model="form.code"
              placeholder="例如 410102-0001"
              :disabled="isEdit"
            />
          </el-form-item>
          <el-form-item label="名称" prop="name">
            <el-input v-model="form.name" maxlength="80" show-word-limit />
          </el-form-item>
          <el-row :gutter="12">
            <el-col :span="12">
              <el-form-item label="类别" prop="category">
                <el-select v-model="form.category" placeholder="选择文物大类">
                  <el-option
                    v-for="c in dict.categories"
                    :key="c.code"
                    :label="`${c.code} ${c.label}`"
                    :value="c.code"
                  />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="保护级别" prop="rank">
                <el-select v-model="form.rank" placeholder="选择保护级别">
                  <el-option
                    v-for="r in dict.ranks"
                    :key="r.code"
                    :label="r.label"
                    :value="r.code"
                  />
                </el-select>
              </el-form-item>
            </el-col>
          </el-row>
          <el-row :gutter="12">
            <el-col :span="12">
              <el-form-item label="来源">
                <el-select v-model="form.search_type" placeholder="普查来源" clearable>
                  <el-option
                    v-for="s in dict.searchTypes"
                    :key="s.code"
                    :label="s.label"
                    :value="s.code"
                  />
                </el-select>
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="年代">
                <el-input v-model="form.era" placeholder="具体年代，如 清代" />
              </el-form-item>
            </el-col>
          </el-row>
          <el-form-item label="年代统计">
            <el-input v-model="form.era_stats" placeholder="统计用归并，如 清" />
          </el-form-item>
          <el-form-item label="简介">
            <el-input
              v-model="form.brief"
              type="textarea"
              :rows="4"
              placeholder="简介 / 备注"
              maxlength="1000"
              show-word-limit
            />
          </el-form-item>
        </el-tab-pane>

        <el-tab-pane label="位置" name="geo">
          <div class="mini-map-wrapper">
            <div ref="miniMapEl" class="mini-map"></div>
            <div class="mini-map-layer-switch">
              <el-radio-group
                v-model="miniLayer"
                size="small"
                @change="switchMiniLayer"
              >
                <el-radio-button value="sat">卫星</el-radio-button>
                <el-radio-button value="osm">街道</el-radio-button>
              </el-radio-group>
            </div>
            <div class="mini-map-coord" v-if="form.lng != null && form.lat != null">
              {{ form.lng!.toFixed(6) }}, {{ form.lat!.toFixed(6) }}
              <span v-if="form.alt != null" class="alt">· {{ form.alt!.toFixed(1) }} m</span>
            </div>
            <div class="mini-map-hint">
              单击地图放置标记 · 拖动标记可微调 · 滚轮缩放
            </div>
          </div>

          <el-row :gutter="12">
            <el-col :span="8">
              <el-form-item label="经度" prop="lng">
                <el-input-number
                  v-model="form.lng"
                  :precision="6"
                  :step="0.0001"
                  controls-position="right"
                  style="width: 100%"
                />
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="纬度" prop="lat">
                <el-input-number
                  v-model="form.lat"
                  :precision="6"
                  :step="0.0001"
                  controls-position="right"
                  style="width: 100%"
                />
              </el-form-item>
            </el-col>
            <el-col :span="8">
              <el-form-item label="海拔(m)">
                <el-input-number
                  v-model="form.alt"
                  :precision="1"
                  :step="1"
                  controls-position="right"
                  style="width: 100%"
                />
              </el-form-item>
            </el-col>
          </el-row>
          <el-form-item>
            <el-button-group>
              <el-button :icon="Aim" type="primary" plain @click="pickOnMap">
                到主图点选
              </el-button>
              <el-button :icon="Location" @click="openOnMap">在主图上查看</el-button>
              <el-button :icon="CopyDocument" @click="copyCoord">复制坐标</el-button>
            </el-button-group>
            <span class="hint">
              <el-icon v-if="waitingPick" class="is-loading" :size="12"><Loading /></el-icon>
              {{ waitingPick ? '等待主图回传坐标…（如已关闭主图请重新点选）' : '坐标为 WGS-84 十进制度。需要三维地形或影像底图时可到主图点选。' }}
            </span>
          </el-form-item>
          <el-row :gutter="12">
            <el-col :span="12">
              <el-form-item label="乡镇">
                <el-input v-model="form.township" />
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="村">
                <el-input v-model="form.village" />
              </el-form-item>
            </el-col>
          </el-row>
          <el-form-item label="地址">
            <el-input v-model="form.address" />
          </el-form-item>
        </el-tab-pane>

        <el-tab-pane label="附件状态" name="flags">
          <el-alert
            type="info"
            :closable="false"
            show-icon
            title="以下标记一般由管线自动维护，手动修改仅用于应急修正"
          />
          <el-form-item label="3D 模型">
            <el-switch v-model="form.has_3d" active-text="已有" inactive-text="无" />
          </el-form-item>
          <el-form-item label="PDF 档案">
            <el-switch v-model="form.has_pdf" active-text="已有" inactive-text="无" />
          </el-form-item>
          <el-form-item label="照片">
            <el-switch v-model="form.has_photo" active-text="已有" inactive-text="无" />
          </el-form-item>
          <el-form-item label="边界">
            <el-switch v-model="form.has_boundary" active-text="已有" inactive-text="无" />
          </el-form-item>
          <el-row :gutter="12">
            <el-col :span="12">
              <el-form-item label="照片数">
                <el-input-number v-model="form.photo_count" :min="0" controls-position="right" style="width: 100%" />
              </el-form-item>
            </el-col>
            <el-col :span="12">
              <el-form-item label="图纸数">
                <el-input-number v-model="form.drawing_count" :min="0" controls-position="right" style="width: 100%" />
              </el-form-item>
            </el-col>
          </el-row>
          <el-form-item label="状态">
            <el-radio-group v-model="form.status">
              <el-radio :value="1">已发布</el-radio>
              <el-radio :value="0">草稿</el-radio>
              <el-radio :value="-1">已删除</el-radio>
            </el-radio-group>
          </el-form-item>
        </el-tab-pane>

        <el-tab-pane
          v-if="isEdit"
          label="相邻文物"
          name="neighbors"
        >
          <template #label>
            <span>
              <el-icon style="vertical-align: -2px"><Connection /></el-icon>
              相邻文物
              <el-badge
                v-if="neighbors.length"
                :value="neighbors.length"
                :max="99"
                class="nb-badge"
              />
            </span>
          </template>

          <div class="nb-toolbar">
            <span class="nb-hint">
              以当前点为中心，
              <el-radio-group
                v-model="nbRadius"
                size="small"
                @change="loadNeighbors"
              >
                <el-radio-button :value="500">500m</el-radio-button>
                <el-radio-button :value="1000">1km</el-radio-button>
                <el-radio-button :value="2000">2km</el-radio-button>
                <el-radio-button :value="5000">5km</el-radio-button>
              </el-radio-group>
              内
            </span>
            <el-button
              size="small"
              plain
              :icon="Refresh"
              :loading="nbLoading"
              @click="loadNeighbors"
            >
              刷新
            </el-button>
          </div>

          <div v-loading="nbLoading" class="nb-list">
            <el-empty
              v-if="!nbLoading && !neighbors.length"
              description="当前范围内没有其它文物"
              :image-size="80"
            />
            <div
              v-for="n in neighbors"
              :key="n.code"
              class="nb-item"
            >
              <div class="nb-head">
                <el-tag
                  size="small"
                  :type="rankTagType(n.rank)"
                  effect="dark"
                  class="nb-rank"
                >
                  {{ rankLabel(n.rank) }}
                </el-tag>
                <span class="nb-name">{{ n.name || n.code }}</span>
                <span class="nb-distance mono">{{ formatDistance(n.distance_m) }}</span>
              </div>
              <div class="nb-meta">
                <span class="mono nb-code">{{ n.code }}</span>
                <span class="nb-sep">·</span>
                <span>{{ categoryLabel(n.category) }}</span>
                <span v-if="n.era_stats" class="nb-sep">·</span>
                <span v-if="n.era_stats">{{ n.era_stats }}</span>
                <span v-if="n.township || n.village" class="nb-sep">·</span>
                <span v-if="n.township || n.village">{{ n.township }}{{ n.village }}</span>
              </div>
              <div class="nb-actions">
                <el-button link type="primary" size="small" @click="openNeighbor(n.code)">
                  打开编辑
                </el-button>
                <el-button link size="small" @click="focusOnMainMap(n.code)">
                  在主图定位
                </el-button>
              </div>
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>

      <div v-if="isEdit" class="version-line">
        <el-tag size="small" effect="plain" type="info">
          版本 v{{ form.expected_version }} · 更新于 {{ form.updated_at_str || '-' }}
        </el-tag>
      </div>
    </el-form>

    <template #footer>
      <div class="dialog-footer">
        <el-button @click="handleClose">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submit">
          {{ isEdit ? '保存修改' : '创建' }}
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox, type FormInstance, type FormRules } from 'element-plus';
import {
  Aim, Connection, CopyDocument, Loading, Location, Refresh, Tickets,
} from '@element-plus/icons-vue';
import L from 'leaflet';
import { adminApi, type AuditRow, type NeighborItem } from '@/api/admin';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useDictStore } from '@/stores/dict';

interface Props {
  modelValue: boolean;
  // null = 新建;string = 按 code 编辑
  code?: string | null;
}
const props = withDefaults(defineProps<Props>(), { code: null });
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'saved', code: string): void;
}>();

const dict = useDictStore();
const auth = useAuthStore();
const router = useRouter();

const activeTab = ref<'basic' | 'geo' | 'flags' | 'neighbors'>('basic');
const loading = ref(false);
const saving = ref(false);
const formRef = ref<FormInstance>();
const recentAudit = ref<AuditRow[]>([]);

// 相邻文物
const neighbors = ref<NeighborItem[]>([]);
const nbLoading = ref(false);
const nbRadius = ref<500 | 1000 | 2000 | 5000>(2000);

// ── mini-map 相关 ───────────────────────────────────
const miniMapEl = ref<HTMLDivElement | null>(null);
const miniLayer = ref<'sat' | 'osm'>('sat');
let leafMap: L.Map | null = null;
let leafMarker: L.Marker | null = null;
let leafTile: L.TileLayer | null = null;
// 防 watch 回环:地图触发的坐标变更会临时置 true。
let syncingFromMap = false;

const MARKER_ICON = L.divIcon({
  className: 'mini-marker',
  html: '<div class="dot"></div><div class="ring"></div>',
  iconSize: [22, 22],
  iconAnchor: [11, 11],
});

interface FormShape {
  code: string;
  name: string;
  category: string;
  rank: string;
  search_type: string;
  era: string;
  era_stats: string;
  brief: string;
  lng: number | null;
  lat: number | null;
  alt: number | null;
  township: string;
  village: string;
  address: string;
  has_3d: boolean;
  has_pdf: boolean;
  has_photo: boolean;
  has_boundary: boolean;
  photo_count: number;
  drawing_count: number;
  status: number;
  // 仅编辑模式使用。
  expected_version: number;
  updated_at_str: string;
}

const emptyForm = (): FormShape => ({
  code: '',
  name: '',
  category: '0600',
  rank: '5',
  search_type: '',
  era: '',
  era_stats: '',
  brief: '',
  lng: null,
  lat: null,
  alt: null,
  township: '',
  village: '',
  address: '',
  has_3d: false,
  has_pdf: false,
  has_photo: false,
  has_boundary: false,
  photo_count: 0,
  drawing_count: 0,
  status: 1,
  expected_version: 1,
  updated_at_str: '',
});

const form = reactive<FormShape>(emptyForm());

const isEdit = computed(() => !!props.code);
const title = computed(() => (isEdit.value ? `编辑文物 · ${props.code}` : '新建文物'));

const rules: FormRules<FormShape> = {
  code: [
    { required: true, message: '请输入编号', trigger: 'blur' },
    { pattern: /^[\w\-]+$/, message: '仅允许字母、数字、下划线、短横线', trigger: 'blur' },
  ],
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
  category: [{ required: true, message: '请选择类别', trigger: 'change' }],
  rank: [{ required: true, message: '请选择保护级别', trigger: 'change' }],
  lng: [{ required: true, type: 'number', message: '请输入经度', trigger: 'blur' }],
  lat: [{ required: true, type: 'number', message: '请输入纬度', trigger: 'blur' }],
};

// 打开对话框时,根据 code 区分编辑/新建并初始化表单。
watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    await dict.ensureLoaded();
    Object.assign(form, emptyForm());
    recentAudit.value = [];
    neighbors.value = [];
    activeTab.value = 'basic';
    if (props.code) {
      await loadExisting(props.code);
    }
  },
);

async function loadExisting(code: string) {
  loading.value = true;
  // 详情与最近变更并行拉取,互不阻塞。
  loadRecentAudit(code);
  try {
    const r: any = await adminApi.getRelic(code);
    // 后端返回 legacy 结构(center_lng / heritage_level / ...),这里统一到表单字段。
    form.code = r.code || r.archive_code || code;
    form.name = r.name || '';
    form.category = normCat(r.category || r.category_main);
    form.rank = normRank(r.rank || r.heritage_level);
    form.search_type = r.search_type || r.survey_type || '';
    form.era = r.era || '';
    form.era_stats = r.era_stats || '';
    form.brief = r.brief || r.description || '';
    form.lng = toNum(r.lng ?? r.center_lng);
    form.lat = toNum(r.lat ?? r.center_lat);
    form.alt = toNum(r.alt ?? r.center_alt);
    form.township = r.township || '';
    form.village = r.village || '';
    form.address = r.address || '';
    form.has_3d = !!r.has_3d;
    form.has_pdf = !!r.has_pdf;
    form.has_photo = !!r.has_photo;
    form.has_boundary = !!r.has_boundary;
    form.photo_count = Number(r.photo_count || 0);
    form.drawing_count = Number(r.drawing_count || 0);
    form.status = Number(r.status ?? 1);
    form.expected_version = Number(r._version ?? r.version ?? 1);
    form.updated_at_str = r._updated_at_str || fmtTs(r.updated_at) || '';
  } catch (e) {
    ElMessage.error('加载详情失败');
    emit('update:modelValue', false);
  } finally {
    loading.value = false;
  }
}

function normCat(v: unknown): string {
  const s = String(v ?? '').trim();
  if (dict.categoryMap[s]) return s;
  const hit = dict.categories.find((c) => c.label === s);
  return hit ? hit.code : '0600';
}
function normRank(v: unknown): string {
  const s = String(v ?? '').trim();
  if (dict.rankMap[s]) return s;
  const hit = dict.ranks.find((c) => c.label === s);
  return hit ? hit.code : '5';
}
function toNum(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function fmtTs(ts: unknown): string {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  return d.toLocaleString('zh-CN', { hour12: false });
}

async function submit() {
  if (!formRef.value) return;
  const ok = await formRef.value.validate().catch(() => false);
  if (!ok) {
    ElMessage.warning('请检查必填字段');
    return;
  }
  saving.value = true;
  const actor = auth.username || 'admin';
  const payload: Record<string, unknown> = {
    code: form.code.trim(),
    name: form.name.trim(),
    category: form.category,
    rank: form.rank,
    search_type: form.search_type || null,
    era: form.era || null,
    era_stats: form.era_stats || null,
    brief: form.brief || null,
    lng: form.lng,
    lat: form.lat,
    alt: form.alt,
    township: form.township || null,
    village: form.village || null,
    address: form.address || null,
    has_3d: form.has_3d,
    has_pdf: form.has_pdf,
    has_photo: form.has_photo,
    has_boundary: form.has_boundary,
    photo_count: form.photo_count,
    drawing_count: form.drawing_count,
    status: form.status,
  };
  try {
    if (isEdit.value) {
      payload.expected_version = form.expected_version;
      await adminApi.updateRelic(form.code, payload, actor);
      ElMessage.success('已保存');
    } else {
      await adminApi.createRelic(payload, actor);
      ElMessage.success('已创建');
    }
    emit('saved', form.code);
    emit('update:modelValue', false);
  } catch (err: any) {
    // 409 版本冲突,提示重新拉取最新版本。
    if (err?.response?.status === 409 && isEdit.value) {
      ElMessageBox.confirm(
        '数据已被他人修改，保存失败。是否重新加载最新版本？',
        '版本冲突',
        { type: 'warning', confirmButtonText: '重新加载', cancelButtonText: '取消' },
      )
        .then(() => loadExisting(form.code))
        .catch(() => {});
    }
    // 其它错误(400 / 404 / 500)由 http 拦截器统一提示。
  } finally {
    saving.value = false;
  }
}

function handleClose() {
  if (saving.value) return;
  emit('update:modelValue', false);
}

// 主图 origin:生产同源留空走相对路径;开发期后台 5173 / 主图 8000 需补全。
const MAIN_MAP_ORIGIN = import.meta.env.DEV
  ? (import.meta.env.VITE_MAIN_MAP_ORIGIN || 'http://127.0.0.1:8000')
  : '';

// 接收 message 的 origin 白名单:生产同源;开发放宽到主图端口。
const ALLOWED_ORIGINS = new Set<string>([
  window.location.origin,
  ...(import.meta.env.DEV
    ? ['http://127.0.0.1:8000', 'http://localhost:8000']
    : []),
]);

function openOnMap() {
  if (!form.code) return;
  const url = `${MAIN_MAP_ORIGIN}/?relic=${encodeURIComponent(form.code)}`;
  window.open(url, '_blank', 'noopener');
}

// ── 主图坐标拾点联动 ─────────────────────────────────
// 1) 新开主图 /?pick=1[&code=...]
// 2) 监听 window.message:relic-pick / relic-pick-cancel → 回填表单
// 3) 主图在回传后自动关窗,本端收到一次后即清理监听。
const pickWinRef = ref<Window | null>(null);
const waitingPick = ref(false);

function pickOnMap() {
  const code = form.code ? `&code=${encodeURIComponent(form.code)}` : '';
  const url = `${MAIN_MAP_ORIGIN}/?pick=1${code}`;
  // 不能带 noopener / noreferrer,主图需通过 window.opener.postMessage 回传。
  const win = window.open(url, 'relics_pick_window');
  if (!win) {
    ElMessage.error('浏览器阻止了弹窗，请允许后再试');
    return;
  }
  pickWinRef.value = win;
  waitingPick.value = true;
  window.addEventListener('message', onPickMessage);
  ElMessage.info('主图已打开，单击地图任意位置即可回填坐标');
}

function onPickMessage(ev: MessageEvent) {
  if (!ALLOWED_ORIGINS.has(ev.origin)) return;
  const data = ev.data;
  if (!data || typeof data !== 'object') return;

  if (data.type === 'relic-pick') {
    // 消息里带 code 且与当前编辑不一致(用户切换了窗口)时忽略。
    if (data.code && form.code && String(data.code) !== String(form.code)) {
      return;
    }
    const lng = Number(data.lng);
    const lat = Number(data.lat);
    if (Number.isFinite(lng) && Number.isFinite(lat)) {
      form.lng = +lng.toFixed(6);
      form.lat = +lat.toFixed(6);
      if (Number.isFinite(Number(data.alt))) {
        form.alt = +Number(data.alt).toFixed(1);
      }
      activeTab.value = 'geo';
      ElMessage.success(`已回填坐标：${form.lng}, ${form.lat}`);
    }
    cleanupPickListener();
  } else if (data.type === 'relic-pick-cancel') {
    ElMessage.info('已取消坐标点选');
    cleanupPickListener();
  }
}

function cleanupPickListener() {
  window.removeEventListener('message', onPickMessage);
  waitingPick.value = false;
  pickWinRef.value = null;
}

onBeforeUnmount(cleanupPickListener);
watch(
  () => props.modelValue,
  (open) => {
    if (!open) cleanupPickListener();
  },
);

function copyCoord() {
  if (form.lng == null || form.lat == null) {
    ElMessage.warning('坐标不完整');
    return;
  }
  const text = `${form.lng.toFixed(6)}, ${form.lat.toFixed(6)}`;
  navigator.clipboard?.writeText(text).then(
    () => ElMessage.success(`已复制：${text}`),
    () => ElMessage.error('复制失败'),
  );
}

// ── 最近变更(编辑模式) ────────────────────────────────
// 保存后重新拉取,让用户立即看到自己的这次变更。
async function loadRecentAudit(code: string) {
  try {
    const resp = await adminApi.listAudit({ code, limit: 5 });
    recentAudit.value = resp.rows || [];
  } catch {
    recentAudit.value = [];
  }
}

function jumpFullHistory() {
  if (!form.code) return;
  // 关闭当前对话框并跳转到审计日志页。
  emit('update:modelValue', false);
  router.push({ path: '/audit', query: { code: form.code } });
}

function auditActionLabel(action: string): string {
  if (action === 'create') return '创建';
  if (action === 'update') return '修改';
  if (action === 'delete') return '删除';
  return action;
}
function auditDotType(
  action: string,
): 'primary' | 'success' | 'warning' | 'danger' | 'info' {
  if (action === 'create') return 'success';
  if (action === 'update') return 'primary';
  if (action === 'delete') return 'danger';
  return 'info';
}
function fmtAuditTs(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  return d.toLocaleString('zh-CN', { hour12: false });
}
// 把一条审计记录摘要成"改了 N 个字段"一句话;create / delete 不摘要。
function auditSummaryText(r: AuditRow): string {
  if (r.action !== 'update') return '';
  let before: Record<string, unknown> = {};
  let after: Record<string, unknown> = {};
  try {
    if (r.before_json) before = JSON.parse(r.before_json) || {};
    if (r.after_json) after = JSON.parse(r.after_json) || {};
  } catch {
    return '';
  }
  const noisy = new Set(['version', 'updated_at', 'created_at']);
  const keys: string[] = [];
  const all = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of all) {
    if (noisy.has(k)) continue;
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      keys.push(FIELD_LABEL[k] || k);
    }
  }
  if (!keys.length) return '（版本号 +1，无业务字段变化）';
  const shown = keys.slice(0, 3).join('、');
  const more = keys.length > 3 ? ` +${keys.length - 3}` : '';
  return `改了 ${keys.length} 个字段：${shown}${more}`;
}

// 字段名中文映射,未覆盖的字段直接显示英文 key。
const FIELD_LABEL: Record<string, string> = {
  name: '名称',
  category: '类别',
  rank: '保护级别',
  search_type: '普查来源',
  era: '年代',
  era_stats: '年代统计',
  brief: '简介',
  lng: '经度', lat: '纬度', alt: '海拔',
  township: '乡镇', village: '村', address: '地址',
  has_3d: '3D 模型', has_pdf: '档案 PDF',
  has_photo: '照片标记', has_boundary: '边界标记',
  photo_count: '照片数', drawing_count: '图纸数',
  status: '状态',
  extra_json: '附加字段',
};

// ── mini-map 初始化 / 销毁 / 同步 ─────────────────────
// 瓦片复用 /tiles/{provider}/{z}/{x}/{y} 代理(开发走 vite proxy,生产同源)。
function tileUrl(kind: 'sat' | 'osm'): string {
  const provider = kind === 'sat' ? 'arcgis_sat' : 'osm';
  return `/tiles/${provider}/{z}/{x}/{y}`;
}

// 默认中心(河南郑州登封附近),作为无坐标时的兜底视图。
const DEFAULT_CENTER: [number, number] = [34.45, 113.03];

async function ensureMiniMap() {
  if (leafMap) {
    // 已存在时确保尺寸正确(Tab 切换 / Dialog 显隐均可能需要)。
    await nextTick();
    leafMap.invalidateSize();
    return;
  }
  await nextTick();
  if (!miniMapEl.value) return;

  const hasCoord = form.lat != null && form.lng != null;
  const center: [number, number] = hasCoord
    ? [Number(form.lat), Number(form.lng)]
    : DEFAULT_CENTER;

  leafMap = L.map(miniMapEl.value, {
    center,
    zoom: hasCoord ? 15 : 9,
    zoomControl: true,
    attributionControl: false,
    preferCanvas: false,
  });
  leafTile = L.tileLayer(tileUrl(miniLayer.value), {
    maxZoom: 19,
    minZoom: 3,
    crossOrigin: true,
  }).addTo(leafMap);

  if (hasCoord) placeMiniMarker(Number(form.lat), Number(form.lng));

  leafMap.on('click', (e: L.LeafletMouseEvent) => {
    const { lat, lng } = e.latlng;
    syncingFromMap = true;
    form.lat = +lat.toFixed(6);
    form.lng = +lng.toFixed(6);
    nextTick(() => {
      syncingFromMap = false;
    });
    placeMiniMarker(lat, lng);
  });

  // 对话框展开动画期间容器尺寸可能未稳定,额外 invalidate 一次。
  setTimeout(() => leafMap?.invalidateSize(), 120);
}

function placeMiniMarker(lat: number, lng: number) {
  if (!leafMap) return;
  if (!leafMarker) {
    leafMarker = L.marker([lat, lng], {
      draggable: true,
      icon: MARKER_ICON,
      autoPan: true,
    }).addTo(leafMap);
    leafMarker.on('dragend', () => {
      if (!leafMarker) return;
      const p = leafMarker.getLatLng();
      syncingFromMap = true;
      form.lat = +p.lat.toFixed(6);
      form.lng = +p.lng.toFixed(6);
      nextTick(() => {
        syncingFromMap = false;
      });
    });
  } else {
    leafMarker.setLatLng([lat, lng]);
  }
}

function switchMiniLayer(v: string | number | boolean | undefined) {
  const kind = (v === 'osm' ? 'osm' : 'sat') as 'sat' | 'osm';
  miniLayer.value = kind;
  if (!leafMap) return;
  if (leafTile) leafMap.removeLayer(leafTile);
  leafTile = L.tileLayer(tileUrl(kind), {
    maxZoom: 19,
    minZoom: 3,
    crossOrigin: true,
  }).addTo(leafMap);
}

function destroyMiniMap() {
  if (leafMap) {
    leafMap.off();
    leafMap.remove();
  }
  leafMap = null;
  leafMarker = null;
  leafTile = null;
}

// 切到"位置"Tab 时按需初始化 / 刷新尺寸。
watch(activeTab, (t) => {
  if (t === 'geo') ensureMiniMap();
  if (t === 'neighbors') {
    // 首次切换才拉,之后由用户手动 refresh。
    if (!neighbors.value.length && !nbLoading.value && isEdit.value) {
      loadNeighbors();
    }
  }
});

// 坐标变化后清空 neighbors,下次切 tab 再拉。
watch(
  () => [form.lng, form.lat] as const,
  () => { neighbors.value = []; },
);

async function loadNeighbors() {
  if (!isEdit.value || !form.code) return;
  nbLoading.value = true;
  try {
    const r = await adminApi.neighbors(form.code, nbRadius.value, 30);
    neighbors.value = r.items || [];
  } catch {
    neighbors.value = [];
  } finally {
    nbLoading.value = false;
  }
}

function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m)} m`;
  return `${(m / 1000).toFixed(2)} km`;
}
function rankLabel(code: string): string {
  const m: Record<string, string> = {
    '1': '国保', '2': '省保', '3': '市保', '4': '县保', '5': '未定级',
  };
  return m[code] || code || '—';
}
function rankTagType(code: string): 'danger' | 'warning' | 'primary' | 'success' | 'info' {
  const m: Record<string, 'danger' | 'warning' | 'primary' | 'success' | 'info'> = {
    '1': 'danger', '2': 'warning', '3': 'primary', '4': 'success', '5': 'info',
  };
  return m[code] || 'info';
}
function categoryLabel(code: string): string {
  return dict.labelOf('category', code);
}

function openNeighbor(code: string) {
  // 关闭当前对话框并让 Relics 页自动打开目标 code 的编辑。
  router.push({ path: '/relics', query: { search: code, auto_open: code } });
  emit('update:modelValue', false);
}

function focusOnMainMap(code: string) {
  window.open(
    `${MAIN_MAP_ORIGIN}/?relic=${encodeURIComponent(code)}`,
    '_blank',
    'noopener',
  );
}

// 外部(加载详情 / 主图回传 / 手工输入)改坐标 → 同步到 marker。
watch(
  () => [form.lng, form.lat] as const,
  ([lng, lat]) => {
    if (syncingFromMap) return;
    if (lng == null || lat == null || !leafMap) return;
    placeMiniMarker(Number(lat), Number(lng));
    leafMap.setView([Number(lat), Number(lng)], Math.max(leafMap.getZoom(), 14), {
      animate: true,
    });
  },
);

// 对话框关闭时清理 Leaflet 实例。
watch(
  () => props.modelValue,
  (open) => {
    if (!open) destroyMiniMap();
  },
);

onBeforeUnmount(() => {
  destroyMiniMap();
});
</script>

<style scoped src="../styles/relic-edit-dialog.css"></style>
<style src="../styles/relic-edit-dialog-global.css"></style>
