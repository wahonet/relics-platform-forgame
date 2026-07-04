<template>
  <div class="page-container audit-page">
    <div class="page-title">
      审计日志
      <span class="sub">全部文物变更记录 · before / after diff</span>
      <div class="top-actions">
        <el-button plain :icon="Refresh" :loading="loading" @click="reload">
          刷新
        </el-button>
      </div>
    </div>

    <el-card class="filter-card" shadow="never">
      <div class="filters">
        <el-input
          v-model="filter.code"
          :prefix-icon="Search"
          placeholder="按文物编号过滤，留空看全部"
          clearable
          class="f-item f-code"
          @keyup.enter="reload"
          @clear="reload"
        />
        <el-select
          v-model="filter.actions"
          placeholder="全部动作"
          multiple
          collapse-tags
          collapse-tags-tooltip
          clearable
          class="f-item f-narrow"
        >
          <el-option label="创建" value="create" />
          <el-option label="更新" value="update" />
          <el-option label="删除" value="delete" />
          <el-option label="回滚" value="rollback" />
        </el-select>
        <el-input
          v-model="filter.actor"
          placeholder="操作者 LIKE"
          clearable
          class="f-item f-narrow"
          @keyup.enter="reload"
          @clear="reload"
        />
        <el-input
          v-model="filter.field"
          placeholder="变更字段（如 lng / name）"
          clearable
          class="f-item f-narrow"
          @keyup.enter="reload"
          @clear="reload"
        />
        <el-input-number
          v-model="filter.limit"
          :min="20"
          :max="500"
          :step="20"
          class="f-item f-num"
          controls-position="right"
        />
        <el-button type="primary" :icon="Search" @click="reload">查询</el-button>
      </div>
    </el-card>

    <el-card class="table-card" shadow="never">
      <el-table
        v-loading="loading"
        :data="filtered"
        stripe
        border
        empty-text="暂无记录"
      >
        <el-table-column label="时间" width="170">
          <template #default="{ row }">
            <span class="mono small">{{ fmtTs(row.ts) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="动作" width="90">
          <template #default="{ row }">
            <el-tag size="small" :type="actionType(row.action)" effect="dark">
              {{ actionLabel(row.action) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="文物编号" prop="relic_code" width="150">
          <template #default="{ row }">
            <el-link type="primary" @click="toRelic(row.relic_code)">
              {{ row.relic_code }}
            </el-link>
          </template>
        </el-table-column>
        <el-table-column label="操作者" prop="actor" width="140">
          <template #default="{ row }">
            <span v-if="row.actor">{{ row.actor }}</span>
            <span v-else class="muted">system</span>
          </template>
        </el-table-column>
        <el-table-column label="变更字段" min-width="280">
          <template #default="{ row }">
            <div v-if="diffSummary(row).length" class="diff-chips">
              <el-tag
                v-for="d in diffSummary(row).slice(0, 6)"
                :key="d.k"
                size="small"
                effect="plain"
                class="chip"
              >
                {{ d.k }}
              </el-tag>
              <span v-if="diffSummary(row).length > 6" class="muted small">
                +{{ diffSummary(row).length - 6 }}
              </span>
            </div>
            <span v-else class="muted small">—</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="180" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :icon="View" @click="showDiff(row)">
              diff
            </el-button>
            <el-popconfirm
              v-if="canRollback(row)"
              :title="rollbackTip(row)"
              confirm-button-text="回滚"
              cancel-button-text="取消"
              confirm-button-type="warning"
              width="260"
              @confirm="doRollback(row)"
            >
              <template #reference>
                <el-button link type="warning" :icon="RefreshLeft">
                  回滚
                </el-button>
              </template>
            </el-popconfirm>
          </template>
        </el-table-column>
      </el-table>
    </el-card>

    <!-- diff 抽屉 -->
    <el-drawer
      v-model="diffVisible"
      :size="780"
      direction="rtl"
      :with-header="true"
      :title="diffTitle"
      append-to-body
    >
      <div v-if="currentRow" class="diff-body">
        <div class="diff-meta">
          <el-descriptions :column="2" size="small" border>
            <el-descriptions-item label="动作">
              <el-tag size="small" :type="actionType(currentRow.action)" effect="dark">
                {{ actionLabel(currentRow.action) }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="操作者">
              {{ currentRow.actor || 'system' }}
            </el-descriptions-item>
            <el-descriptions-item label="时间">
              {{ fmtTs(currentRow.ts) }}
            </el-descriptions-item>
            <el-descriptions-item label="文物">
              <el-link type="primary" @click="toRelic(currentRow.relic_code)">
                {{ currentRow.relic_code }}
              </el-link>
            </el-descriptions-item>
          </el-descriptions>
        </div>

        <el-tabs v-model="diffTab" class="diff-tabs">
          <el-tab-pane label="字段级 diff" name="diff">
            <el-table :data="fullDiff" border size="small" empty-text="无字段变更">
              <el-table-column label="字段" prop="k" width="180" />
              <el-table-column label="修改前">
                <template #default="{ row }">
                  <code class="before">{{ formatVal(row.before) }}</code>
                </template>
              </el-table-column>
              <el-table-column label="修改后">
                <template #default="{ row }">
                  <code class="after">{{ formatVal(row.after) }}</code>
                </template>
              </el-table-column>
            </el-table>
          </el-tab-pane>

          <el-tab-pane label="修改前 JSON" name="before">
            <pre class="json-pane">{{ prettyBefore }}</pre>
          </el-tab-pane>
          <el-tab-pane label="修改后 JSON" name="after">
            <pre class="json-pane">{{ prettyAfter }}</pre>
          </el-tab-pane>
        </el-tabs>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { Refresh, RefreshLeft, Search, View } from '@element-plus/icons-vue';
import { adminApi, type AuditRow } from '@/api/admin';
import { useAuthStore } from '@/stores/auth';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const filter = reactive({
  code: (route.query.code as string) || '',
  actions: [] as string[],
  actor: '',
  field: '',
  limit: 100,
});

const rows = ref<AuditRow[]>([]);
const loading = ref(false);

const diffVisible = ref(false);
const currentRow = ref<AuditRow | null>(null);
const diffTab = ref<'diff' | 'before' | 'after'>('diff');

async function reload() {
  loading.value = true;
  try {
    const resp = await adminApi.listAudit({
      code: filter.code.trim() || undefined,
      action: filter.actions.length ? filter.actions.join(',') : undefined,
      actor: filter.actor.trim() || undefined,
      field: filter.field.trim() || undefined,
      limit: filter.limit,
    });
    rows.value = resp.rows;
  } catch {
    rows.value = [];
  } finally {
    loading.value = false;
  }
}

// 筛选下沉到后端;本地仅保留原表行引用,便于后续扩展细化筛选。
const filtered = computed<AuditRow[]>(() => rows.value);

watch(
  () => route.query.code,
  (v) => {
    const s = (v as string) || '';
    if (s && s !== filter.code) {
      filter.code = s;
      reload();
    }
  },
);

onMounted(reload);

// ── diff 计算 ─────────────────────────────────────
function parseJson(s: string | null): Record<string, unknown> {
  if (!s) return {};
  try {
    return JSON.parse(s) || {};
  } catch {
    return {};
  }
}

interface DiffEntry { k: string; before: unknown; after: unknown }

function computeDiff(row: AuditRow): DiffEntry[] {
  const before = parseJson(row.before_json);
  const after = parseJson(row.after_json);
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const out: DiffEntry[] = [];
  for (const k of keys) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      out.push({ k, before: before[k], after: after[k] });
    }
  }
  // version / updated_at 属于自然变化,排到末尾。
  const noisy = new Set(['version', 'updated_at', 'created_at']);
  out.sort((a, b) => {
    const aN = noisy.has(a.k) ? 1 : 0;
    const bN = noisy.has(b.k) ? 1 : 0;
    if (aN !== bN) return aN - bN;
    return a.k.localeCompare(b.k);
  });
  return out;
}

function diffSummary(row: AuditRow): DiffEntry[] {
  return computeDiff(row).filter(
    (d) => !['version', 'updated_at', 'created_at'].includes(d.k),
  );
}

const fullDiff = computed<DiffEntry[]>(() =>
  currentRow.value ? computeDiff(currentRow.value) : [],
);
const prettyBefore = computed(() =>
  currentRow.value ? formatJson(currentRow.value.before_json) : '',
);
const prettyAfter = computed(() =>
  currentRow.value ? formatJson(currentRow.value.after_json) : '',
);
const diffTitle = computed(() =>
  currentRow.value
    ? `${actionLabel(currentRow.value.action)} · ${currentRow.value.relic_code}`
    : 'diff',
);

function formatJson(s: string | null): string {
  if (!s) return '(空)';
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function showDiff(row: AuditRow) {
  currentRow.value = row;
  diffTab.value = 'diff';
  diffVisible.value = true;
}

function canRollback(row: AuditRow): boolean {
  // rollback 本身也允许再回滚一次(等价于反向 redo)。
  if (!['create', 'update', 'delete', 'rollback'].includes(row.action)) return false;
  // update / delete / rollback 需要 before_json 才能还原。
  if (row.action !== 'create' && !row.before_json) return false;
  return true;
}

function rollbackTip(row: AuditRow): string {
  if (row.action === 'create') {
    return `将该记录视为"新建"，回滚会软删文物 ${row.relic_code}，确认？`;
  }
  if (row.action === 'delete') {
    return `将恢复文物 ${row.relic_code} 到删除前的内容，确认？`;
  }
  return `将文物 ${row.relic_code} 回滚到这次变更前的状态，确认？`;
}

async function doRollback(row: AuditRow) {
  try {
    const r = await adminApi.rollbackAudit(row.id, auth.username);
    ElMessage.success(
      r.action_taken === 'delete'
        ? `已回滚（软删）${r.code}`
        : `已回滚 ${r.code}`,
    );
    await reload();
  } catch (e) {
    const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
    ElMessage.error(msg || '回滚失败');
  }
}

function toRelic(code: string) {
  const params = new URLSearchParams({ search: code });
  router.push({ path: '/relics', query: { search: code } }).catch(() => {});
  void params;
}

function actionLabel(a: string): string {
  if (a === 'create') return '创建';
  if (a === 'update') return '更新';
  if (a === 'delete') return '删除';
  return a;
}
function actionType(a: string): 'success' | 'warning' | 'danger' | 'info' {
  if (a === 'create') return 'success';
  if (a === 'update') return 'warning';
  if (a === 'delete') return 'danger';
  return 'info';
}
function fmtTs(ts: number): string {
  if (!ts) return '—';
  const d = new Date(ts * 1000);
  return d.toLocaleString('zh-CN', { hour12: false });
}
function formatVal(v: unknown): string {
  if (v === null || v === undefined) return '∅';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}
</script>

<style scoped>
.audit-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.top-actions { margin-left: auto; }
.filter-card :deep(.el-card__body) { padding: 12px; }
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.f-item { width: 200px; }
.f-code { width: 280px; }
.f-narrow { width: 160px; }
.f-num { width: 140px; }

.table-card :deep(.el-card__body) { padding: 0; }

.diff-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.chip { font-family: var(--el-font-family-mono, monospace); }

.diff-body {
  padding: 0 16px 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
}
.diff-meta { flex-shrink: 0; }
.diff-tabs { flex: 1; }
.json-pane {
  background: var(--el-fill-color-darker);
  color: var(--el-text-color-primary);
  padding: 12px;
  border-radius: 6px;
  font-family: var(--el-font-family-mono, monospace);
  font-size: 12px;
  line-height: 1.5;
  max-height: 62vh;
  overflow: auto;
}
code.before {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.08);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 12px;
  word-break: break-all;
}
code.after {
  color: #22c55e;
  background: rgba(34, 197, 94, 0.08);
  padding: 1px 6px;
  border-radius: 3px;
  font-size: 12px;
  word-break: break-all;
}
.mono {
  font-family: var(--el-font-family-mono, ui-monospace, Menlo, Consolas, monospace);
  font-size: 12px;
}
.small { font-size: 12px; }
.muted { color: var(--el-text-color-placeholder); }
</style>
