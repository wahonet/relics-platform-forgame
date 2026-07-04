<template>
  <div class="page-container relics-page">
    <div class="page-title">
      文物数据
      <span class="sub">{{ statusLabel(activeStatus) }} · 共 {{ total }} 条</span>
      <div class="top-actions">
        <el-button plain :icon="Refresh" :loading="loading" @click="reload">
          刷新
        </el-button>
        <el-button
          plain
          :icon="MapLocation"
          :type="bboxFilter ? 'primary' : ''"
          @click="openBboxPicker"
        >
          {{ bboxFilter ? '已框选区域' : '地图框选' }}
        </el-button>
        <el-button plain :icon="Download" @click="exportCurrent">
          导出筛选
        </el-button>
        <el-button
          v-if="activeStatus === 1"
          type="primary"
          :icon="Plus"
          @click="openCreate"
        >
          新建文物
        </el-button>
      </div>
    </div>

    <!-- 状态 Tab -->
    <el-radio-group
      v-model="activeStatus"
      class="status-tabs"
      @change="onStatusChange"
    >
      <el-radio-button :value="1">已发布</el-radio-button>
      <el-radio-button :value="0">草稿</el-radio-button>
      <el-radio-button :value="-1">
        <el-icon class="tab-icon"><Delete /></el-icon>
        回收站
      </el-radio-button>
    </el-radio-group>

    <!-- 筛选栏 -->
    <el-card class="filter-card" shadow="never">
      <div class="filters">
        <el-input
          v-model="query.search"
          :prefix-icon="Search"
          placeholder="按编号或名称搜索"
          clearable
          class="f-item f-search"
          @keyup.enter="applyFilters"
          @clear="applyFilters"
        />
        <el-select
          v-model="query.category"
          multiple
          collapse-tags
          collapse-tags-tooltip
          placeholder="全部类别"
          clearable
          class="f-item"
          @change="applyFilters"
        >
          <el-option
            v-for="c in dict.categories"
            :key="c.code"
            :label="c.label"
            :value="c.code"
          />
        </el-select>
        <el-select
          v-model="query.rank"
          multiple
          collapse-tags
          collapse-tags-tooltip
          placeholder="全部级别"
          clearable
          class="f-item"
          @change="applyFilters"
        >
          <el-option
            v-for="r in dict.ranks"
            :key="r.code"
            :label="r.label"
            :value="r.code"
          />
        </el-select>
        <el-select
          v-model="query.township"
          filterable
          placeholder="乡镇"
          clearable
          class="f-item"
          @change="applyFilters"
        >
          <el-option
            v-for="t in townshipOptions"
            :key="t"
            :label="t"
            :value="t"
          />
        </el-select>
        <el-select
          v-model="query.search_type"
          placeholder="来源"
          clearable
          class="f-item f-narrow"
          @change="applyFilters"
        >
          <el-option
            v-for="s in dict.searchTypes"
            :key="s.code"
            :label="s.label"
            :value="s.code"
          />
        </el-select>
        <el-select
          v-model="query.order_by"
          class="f-item f-narrow"
          @change="applyFilters"
        >
          <el-option label="最近更新" value="updated_at_desc" />
          <el-option label="最早更新" value="updated_at_asc" />
          <el-option label="编号升序" value="code_asc" />
          <el-option label="编号降序" value="code_desc" />
          <el-option label="名称升序" value="name_asc" />
        </el-select>
        <el-button @click="resetFilters">重置</el-button>
      </div>
      <div v-if="bboxFilter" class="bbox-chip-row">
        <el-tag
          type="primary"
          effect="plain"
          closable
          class="bbox-chip"
          @close="clearBbox"
        >
          <el-icon><MapLocation /></el-icon>
          空间范围：
          <span class="mono">
            {{ bboxFilter[0].toFixed(4) }}, {{ bboxFilter[1].toFixed(4) }}
            ~ {{ bboxFilter[2].toFixed(4) }}, {{ bboxFilter[3].toFixed(4) }}
          </span>
        </el-tag>
        <el-button link size="small" @click="openBboxPicker">重新框选</el-button>
      </div>
    </el-card>

    <!-- 批量操作栏 -->
    <div v-if="selectedCount > 0" class="bulk-bar">
      <div class="bulk-info">
        <el-icon><CircleCheck /></el-icon>
        已选 <b>{{ selectedCount }}</b> 条
        <el-button link size="small" @click="clearSelection">清空选择</el-button>
      </div>
      <div class="bulk-actions">
        <!-- 回收站：只有恢复 / 导出 -->
        <template v-if="activeStatus === -1">
          <el-button size="small" :icon="RefreshLeft" type="success" plain @click="bulkSetStatus(1)">
            批量恢复
          </el-button>
          <el-button size="small" :icon="Download" @click="exportSelected">
            导出选中
          </el-button>
        </template>

        <!-- 非回收站：发布/草稿/改字段/删除/导出 -->
        <template v-else>
          <el-button
            v-if="activeStatus !== 1"
            size="small"
            :icon="Upload"
            type="success"
            plain
            @click="bulkSetStatus(1)"
          >
            发布
          </el-button>
          <el-button
            v-if="activeStatus !== 0"
            size="small"
            :icon="EditPen"
            @click="bulkSetStatus(0)"
          >
            置草稿
          </el-button>
          <el-button size="small" :icon="Edit" type="primary" plain @click="openBulkEdit">
            批量改字段
          </el-button>
          <el-button size="small" :icon="Download" @click="exportSelected">
            导出选中
          </el-button>
          <el-popconfirm
            :title="bulkDeleteTip"
            confirm-button-text="删除"
            cancel-button-text="取消"
            :width="280"
            @confirm="bulkSetStatus(-1)"
          >
            <template #reference>
              <el-button size="small" :icon="Delete" type="danger" plain>批量删除</el-button>
            </template>
          </el-popconfirm>
        </template>
      </div>
    </div>

    <!-- 表格 -->
    <el-card class="table-card" shadow="never">
      <el-table
        ref="tableRef"
        v-loading="loading"
        :data="rows"
        stripe
        border
        row-key="code"
        class="relics-table"
        :empty-text="emptyText"
        :row-class-name="rowClassName"
        @row-dblclick="(row: RelicRow) => openEdit(row.code)"
        @selection-change="onSelectionChange"
      >
        <el-table-column type="selection" width="44" fixed reserve-selection />
        <el-table-column label="编号" prop="code" width="180" fixed>
          <template #default="{ row }">
            <div class="code-cell">
              <el-link type="primary" @click="openEdit(row.code)">{{ row.code }}</el-link>
              <el-tooltip content="在主图上定位" placement="top">
                <el-button
                  link
                  size="small"
                  :icon="MapLocation"
                  class="code-map-btn"
                  @click.stop="openOnMap(row.code)"
                />
              </el-tooltip>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="名称" prop="name" min-width="220" show-overflow-tooltip />
        <el-table-column label="类别" width="120">
          <template #default="{ row }">
            <el-tag size="small" effect="plain">
              {{ dict.labelOf('category', row.category) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="级别" width="110">
          <template #default="{ row }">
            <el-tag size="small" :type="rankTagType(row.rank)" effect="dark">
              {{ shortRank(row.rank) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="乡镇" prop="township" width="120" show-overflow-tooltip />
        <el-table-column label="年代" prop="era" width="120" show-overflow-tooltip />
        <el-table-column label="坐标" width="180">
          <template #default="{ row }">
            <span v-if="row.lng != null && row.lat != null" class="mono">
              {{ row.lng.toFixed(5) }}, {{ row.lat.toFixed(5) }}
            </span>
            <span v-else class="muted">—</span>
          </template>
        </el-table-column>
        <el-table-column label="附件" width="140">
          <template #default="{ row }">
            <div class="badges">
              <el-tooltip v-if="row.has_3d" content="3D 模型" placement="top">
                <span class="badge b-3d">3D</span>
              </el-tooltip>
              <el-tooltip v-if="row.has_pdf" content="档案 PDF" placement="top">
                <span class="badge b-pdf">PDF</span>
              </el-tooltip>
              <el-tooltip v-if="row.photo_count > 0" :content="`${row.photo_count} 张照片`" placement="top">
                <span class="badge b-photo">照{{ row.photo_count }}</span>
              </el-tooltip>
              <el-tooltip v-if="row.drawing_count > 0" :content="`${row.drawing_count} 张图纸`" placement="top">
                <span class="badge b-draw">图{{ row.drawing_count }}</span>
              </el-tooltip>
              <el-tooltip v-if="row.has_boundary" content="已描边界" placement="top">
                <span class="badge b-poly">界</span>
              </el-tooltip>
              <span v-if="!hasAnyFlag(row)" class="muted">—</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column label="状态" width="90">
          <template #default="{ row }">
            <el-tag
              size="small"
              :type="statusType(row.status)"
              effect="plain"
            >
              {{ statusLabel(row.status) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column label="更新时间" width="160">
          <template #default="{ row }">
            <span class="mono small">{{ fmtTs(row.updated_at) }}</span>
          </template>
        </el-table-column>
        <el-table-column label="操作" width="210" fixed="right">
          <template #default="{ row }">
            <el-button link type="primary" :icon="Edit" @click="openEdit(row.code)">编辑</el-button>
            <el-button link :icon="Tickets" @click="viewAudit(row.code)">历史</el-button>
            <template v-if="row.status === -1">
              <el-button
                link
                type="success"
                :icon="RefreshLeft"
                @click="doRestore(row.code)"
              >
                恢复
              </el-button>
            </template>
            <template v-else>
              <el-popconfirm
                :title="rowDeleteTip(row.code)"
                confirm-button-text="删除"
                cancel-button-text="取消"
                :width="240"
                @confirm="doDelete(row.code)"
              >
                <template #reference>
                  <el-button link type="danger" :icon="Delete">删除</el-button>
                </template>
              </el-popconfirm>
            </template>
          </template>
        </el-table-column>
      </el-table>

      <div class="pager">
        <el-pagination
          v-model:current-page="query.page"
          v-model:page-size="query.size"
          :page-sizes="[10, 20, 50, 100]"
          :total="total"
          layout="total, sizes, prev, pager, next, jumper"
          background
          @size-change="reload"
          @current-change="reload"
        />
      </div>
    </el-card>

    <RelicEditDialog
      v-model="editVisible"
      :code="editingCode"
      @saved="onSaved"
    />

    <RelicBulkEditDialog
      v-model="bulkEditVisible"
      :codes="selectedCodes"
      @done="onBulkDone"
    />

    <BboxPickerDialog
      v-model="bboxPickerVisible"
      :initial-bbox="bboxFilter"
      :points="rows.map((r) => ({ lng: r.lng, lat: r.lat }))"
      @confirm="onBboxConfirm"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import {
  CircleCheck, Delete, Download, Edit, EditPen, MapLocation,
  Plus, Refresh, RefreshLeft, Search, Tickets, Upload,
} from '@element-plus/icons-vue';
import type { RelicRow } from '@/api/admin';
import { useDictStore } from '@/stores/dict';
import { useRelicsList } from '@/composables/useRelicsList';
import RelicEditDialog from '@/components/RelicEditDialog.vue';
import RelicBulkEditDialog from '@/components/RelicBulkEditDialog.vue';
import BboxPickerDialog from '@/components/BboxPickerDialog.vue';

const route = useRoute();
const router = useRouter();
const dict = useDictStore();
const {
  query,
  loading,
  rows,
  total,
  townshipOptions,
  activeStatus,
  emptyText,
  tableRef,
  selectedCount,
  selectedCodes,
  bulkEditVisible,
  bulkDeleteTip,
  bboxPickerVisible,
  bboxFilter,
  reload,
  loadTownshipOptions,
  onStatusChange,
  applyFilters,
  resetFilters,
  openBboxPicker,
  onBboxConfirm,
  clearBbox,
  onSelectionChange,
  clearSelection,
  doDelete,
  doRestore,
  openBulkEdit,
  onBulkDone,
  bulkSetStatus,
  exportCurrent,
  exportSelected,
  syncQueryFromRoute,
} = useRelicsList();

const editVisible = ref(false);
const editingCode = ref<string | null>(null);

function rowClassName({ row }: { row: RelicRow }): string {
  return row.status === -1 ? 'row-deleted' : '';
}
function rowDeleteTip(code: string): string {
  return `确认删除 ${code}？将执行软删除，可在回收站恢复`;
}

function openCreate() {
  editingCode.value = null;
  editVisible.value = true;
}
function openEdit(code: string) {
  editingCode.value = code;
  editVisible.value = true;
}
function onSaved() {
  reload();
  loadTownshipOptions();
}

function viewAudit(code: string) {
  router.push({ path: '/audit', query: { code } });
}

// 主图 origin:生产同源留空;开发期后台 5173 / 主图 8000。
const MAIN_MAP_ORIGIN = import.meta.env.DEV
  ? (import.meta.env.VITE_MAIN_MAP_ORIGIN || 'http://127.0.0.1:8000')
  : '';
function openOnMap(code: string) {
  const url = `${MAIN_MAP_ORIGIN}/?relic=${encodeURIComponent(code)}`;
  window.open(url, '_blank', 'noopener');
}

// 工具
function rankTagType(r: string): 'danger' | 'warning' | 'primary' | 'success' | 'info' {
  const m: Record<string, 'danger' | 'warning' | 'primary' | 'success' | 'info'> = {
    '1': 'danger', '2': 'warning', '3': 'primary', '4': 'success', '5': 'info',
  };
  return m[r] || 'info';
}
function shortRank(r: string): string {
  const m: Record<string, string> = {
    '1': '国保', '2': '省保', '3': '市保', '4': '县保', '5': '未定级',
  };
  return m[r] || r || '—';
}
function statusLabel(s: number): string {
  if (s === 1) return '已发布';
  if (s === 0) return '草稿';
  if (s === -1) return '已删除';
  return String(s);
}
function statusType(s: number): 'success' | 'warning' | 'danger' | 'info' {
  if (s === 1) return 'success';
  if (s === 0) return 'warning';
  if (s === -1) return 'danger';
  return 'info';
}
function fmtTs(ts: string | null): string {
  if (!ts) return '—';
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n * 1000);
  return d.toLocaleString('zh-CN', { hour12: false });
}
function hasAnyFlag(row: RelicRow): boolean {
  return !!(row.has_3d || row.has_pdf || row.has_boundary || row.photo_count || row.drawing_count);
}

// 从 URL query 读取筛选条件(Dashboard / Audit 跳转过来时用)。
function syncFromRoute() {
  syncQueryFromRoute(route.query);
}

// 路由 query 变动(同路由内再次跳转)时同步筛选条件。
watch(() => route.query, () => {
  syncFromRoute();
  reload();
  maybeAutoOpen();
});

async function maybeAutoOpen() {
  const target = typeof route.query.auto_open === 'string' ? route.query.auto_open : '';
  if (!target) return;
  // 清掉 auto_open 参数,避免刷新 / 后退重复触发。
  const q = { ...route.query };
  delete q.auto_open;
  await router.replace({ path: '/relics', query: q }).catch(() => {});
  // 对话框内部会根据 code 主动拉取详情,失败不影响其它流程。
  openEdit(target);
}

onMounted(async () => {
  syncFromRoute();
  await dict.ensureLoaded();
  loadTownshipOptions();
  reload();
  maybeAutoOpen();
});
</script>

<style scoped src="../styles/relics.css"></style>
