import { computed, reactive, ref } from 'vue';
import type { LocationQuery } from 'vue-router';
import { ElMessage } from 'element-plus';
import type { TableInstance } from 'element-plus';
import { adminApi, type BulkResult, type RelicRow, type RelicsListQuery } from '@/api/admin';
import { useAuthStore } from '@/stores/auth';

export interface LocalRelicsQuery {
  page: number;
  size: number;
  search: string;
  category: string[];
  rank: string[];
  township: string;
  search_type: string;
  order_by: NonNullable<RelicsListQuery['order_by']>;
}

export function useRelicsList() {
  const auth = useAuthStore();
  const query = reactive<LocalRelicsQuery>({
    page: 1,
    size: 20,
    search: '',
    category: [],
    rank: [],
    township: '',
    search_type: '',
    order_by: 'updated_at_desc',
  });

  const loading = ref(false);
  const rows = ref<RelicRow[]>([]);
  const total = ref(0);
  const townshipOptions = ref<string[]>([]);

  const activeStatus = ref<1 | 0 | -1>(1);
  const emptyText = computed(() => {
    if (activeStatus.value === -1) return '回收站为空';
    if (activeStatus.value === 0) return '没有草稿文物';
    return '暂无数据';
  });

  const tableRef = ref<TableInstance>();
  const selectedRows = ref<RelicRow[]>([]);
  const selectedCount = computed(() => selectedRows.value.length);
  const selectedCodes = computed(() => selectedRows.value.map((r) => r.code));
  const bulkEditVisible = ref(false);
  const bulkDeleteTip = computed(
    () => `确认对 ${selectedCount.value} 条文物执行软删除？可随后在"草稿/已删除"恢复`,
  );

  const bboxPickerVisible = ref(false);
  const bboxFilter = ref<[number, number, number, number] | null>(null);
  const bboxParam = computed(() =>
    bboxFilter.value ? bboxFilter.value.join(',') : undefined,
  );

  function listParams(): RelicsListQuery {
    return {
      page: query.page,
      size: query.size,
      search: query.search.trim() || undefined,
      category: query.category.length ? query.category.join(',') : undefined,
      rank: query.rank.length ? query.rank.join(',') : undefined,
      township: query.township || undefined,
      search_type: query.search_type || undefined,
      order_by: query.order_by,
      status: activeStatus.value,
      bbox: bboxParam.value,
    };
  }

  async function reload() {
    loading.value = true;
    try {
      const resp = await adminApi.listRelics(listParams());
      rows.value = resp.data;
      total.value = resp.total;
    } catch {
      rows.value = [];
      total.value = 0;
    } finally {
      loading.value = false;
    }
  }

  async function loadTownshipOptions() {
    try {
      const resp = await adminApi.relicsTownships();
      townshipOptions.value = resp.townships;
    } catch {
      townshipOptions.value = [];
    }
  }

  function onStatusChange() {
    query.page = 1;
    clearSelection();
    reload();
  }

  function applyFilters() {
    query.page = 1;
    reload();
  }

  function resetFilters() {
    query.search = '';
    query.category = [];
    query.rank = [];
    query.township = '';
    query.search_type = '';
    query.order_by = 'updated_at_desc';
    bboxFilter.value = null;
    applyFilters();
  }

  function openBboxPicker() {
    bboxPickerVisible.value = true;
  }

  function onBboxConfirm(b: [number, number, number, number]) {
    bboxFilter.value = b;
    query.page = 1;
    reload();
  }

  function clearBbox() {
    bboxFilter.value = null;
    query.page = 1;
    reload();
  }

  function onSelectionChange(rows: RelicRow[]) {
    selectedRows.value = rows;
  }

  function clearSelection() {
    tableRef.value?.clearSelection();
    selectedRows.value = [];
  }

  async function doDelete(code: string) {
    try {
      await adminApi.deleteRelic(code, auth.username || 'admin');
      ElMessage.success(`已删除 ${code}`);
      reload();
    } catch {
      // 拦截器已提示
    }
  }

  async function doRestore(code: string) {
    try {
      const r = await adminApi.bulkSetStatus([code], 1, auth.username || 'admin');
      if ((r.updated ?? 0) > 0) {
        ElMessage.success(`已恢复 ${code}（发布状态）`);
      } else if (r.failed?.length) {
        ElMessage.error(`恢复失败：${r.failed[0].error}`);
      }
      reload();
    } catch {
      // ignore
    }
  }

  function openBulkEdit() {
    if (selectedCount.value === 0) return;
    bulkEditVisible.value = true;
  }

  function onBulkDone() {
    clearSelection();
    reload();
  }

  async function bulkSetStatus(status: 1 | 0 | -1) {
    if (selectedCount.value === 0) return;
    try {
      const r = await adminApi.bulkSetStatus(
        selectedCodes.value,
        status,
        auth.username || 'admin',
      );
      const action =
        status === -1 ? '删除'
        : status === 1
          ? (activeStatus.value === -1 ? '恢复' : '发布')
          : '置草稿';
      summarizeBulk(r, action);
      clearSelection();
      reload();
    } catch {
      // ignore
    }
  }

  function summarizeBulk(r: BulkResult, action: string) {
    const ok = r.updated ?? r.deleted ?? 0;
    const parts = [`${action}成功 ${ok}`];
    if (r.not_found?.length) parts.push(`未找到 ${r.not_found.length}`);
    if (r.failed?.length) parts.push(`失败 ${r.failed.length}`);
    const msg = parts.join(' · ');
    if ((r.failed?.length ?? 0) > 0 || (r.not_found?.length ?? 0) > 0) {
      ElMessage.warning(msg);
      // eslint-disable-next-line no-console
      console.warn('[bulk]', { action, ...r });
    } else {
      ElMessage.success(msg);
    }
  }

  function exportCurrent() {
    if (total.value === 0) {
      ElMessage.warning('当前筛选下没有可导出的数据');
      return;
    }
    const url = adminApi.exportRelicsUrl(listParams());
    triggerDownload(url);
    ElMessage.success(`已开始导出当前筛选，共约 ${total.value} 条`);
  }

  function exportSelected() {
    if (selectedCount.value === 0) return;
    const url = adminApi.exportRelicsUrl({ codes: selectedCodes.value.join(',') });
    triggerDownload(url);
    ElMessage.success(`已开始导出选中 ${selectedCount.value} 条`);
  }

  function triggerDownload(url: string) {
    const a = document.createElement('a');
    a.href = url;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function syncQueryFromRoute(routeQuery: LocationQuery) {
    if (typeof routeQuery.search === 'string') query.search = routeQuery.search;
    if (typeof routeQuery.category === 'string') {
      query.category = routeQuery.category.split(',').filter(Boolean);
    }
    if (typeof routeQuery.rank === 'string') {
      query.rank = routeQuery.rank.split(',').filter(Boolean);
    }
    if (typeof routeQuery.township === 'string') query.township = routeQuery.township;
    if (typeof routeQuery.search_type === 'string') query.search_type = routeQuery.search_type;
    if (typeof routeQuery.status === 'string') {
      const n = Number(routeQuery.status);
      if (n === 1 || n === 0 || n === -1) activeStatus.value = n;
    }
    query.page = 1;
  }

  return {
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
    bboxParam,
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
  };
}

