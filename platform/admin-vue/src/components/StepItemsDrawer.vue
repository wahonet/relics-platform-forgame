<template>
  <el-drawer
    v-model="visible"
    :size="680"
    direction="rtl"
    :with-header="false"
  >
    <div class="items-drawer">
      <div class="head">
        <div class="title">
          <el-icon :size="18"><Document /></el-icon>
          <span>{{ title }}</span>
        </div>
        <el-button text @click="visible = false">
          <el-icon :size="18"><Close /></el-icon>
        </el-button>
      </div>

      <div v-if="loading" class="loading">
        <el-icon class="is-loading" :size="20"><Loading /></el-icon>
        正在加载明细…
      </div>

      <div v-else-if="!groups.length" class="empty">
        暂无数据 —— 可能是尚未运行此步骤，或输入目录为空。
      </div>

      <el-scrollbar v-else class="body">
        <el-collapse v-model="activeGroups">
          <el-collapse-item
            v-for="(g, gi) in groups"
            :key="g.name"
            :name="g.name"
          >
            <template #title>
              <div class="grp-hdr">
                <span class="gname">{{ g.name }}</span>
                <el-progress
                  :percentage="pct(g)"
                  :stroke-width="6"
                  :show-text="false"
                  :color="pctColor(pct(g))"
                  class="gbar"
                />
                <span class="gcount">
                  <b>{{ g.done }}</b> / {{ g.total }}
                </span>
              </div>
            </template>

            <el-table
              :data="g.items"
              size="small"
              stripe
              class="items-tbl"
              :empty-text="'此分组下暂无条目'"
            >
              <el-table-column label="状态" width="90">
                <template #default="{ row }">
                  <el-tag
                    :type="statusType(row.status)"
                    size="small"
                    effect="dark"
                  >
                    {{ statusText(row.status) }}
                  </el-tag>
                </template>
              </el-table-column>

              <!-- 列动态按 stepId 配置 -->
              <template v-for="col in cols" :key="col.prop">
                <el-table-column
                  :prop="col.prop"
                  :label="col.label"
                  :width="col.width"
                  :show-overflow-tooltip="col.ellipsis"
                >
                  <template v-if="col.formatter" #default="{ row }">
                    {{ col.formatter(row) }}
                  </template>
                </el-table-column>
              </template>
            </el-table>

            <div class="grp-foot" v-if="gi < groups.length - 1" />
          </el-collapse-item>
        </el-collapse>
      </el-scrollbar>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Close, Document, Loading } from '@element-plus/icons-vue';
import { adminApi, type StepGroup, type StepItem } from '@/api/admin';

interface ColDef {
  prop: string;
  label: string;
  width?: string | number;
  ellipsis?: boolean;
  formatter?: (row: StepItem) => string;
}

const props = defineProps<{
  modelValue: boolean;
  stepId: string | null;
  stepName?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
}>();

const visible = ref(props.modelValue);
watch(
  () => props.modelValue,
  (v) => {
    visible.value = v;
    if (v && props.stepId) void load(props.stepId);
  },
);
watch(visible, (v) => emit('update:modelValue', v));
watch(
  () => props.stepId,
  (v) => {
    if (v && visible.value) void load(v);
  },
);

const loading = ref(false);
const groups = ref<StepGroup[]>([]);
const activeGroups = ref<string[]>([]);

const title = computed(() => `${props.stepName || props.stepId || '明细'} · 明细`);

async function load(stepId: string) {
  loading.value = true;
  groups.value = [];
  try {
    const data = await adminApi.stepItems(stepId);
    groups.value = data.groups || [];
    // 默认展开第一个分组
    activeGroups.value = groups.value.slice(0, 1).map((g) => g.name);
  } catch {
    // 拦截器已提示
  } finally {
    loading.value = false;
  }
}

function pct(g: StepGroup) {
  return g.total > 0 ? Math.round((g.done / g.total) * 100) : 0;
}
function pctColor(p: number) {
  if (p >= 100) return '#3fb950';
  if (p > 0) return '#d29922';
  return '#58a6ff';
}

function statusType(s?: string) {
  if (s === 'done') return 'success';
  if (s === 'error') return 'danger';
  return 'info';
}
function statusText(s?: string) {
  if (s === 'done') return '已完成';
  if (s === 'error') return '失败';
  return '待处理';
}

// 按 stepId 选列
const cols = computed<ColDef[]>(() => {
  const sid = props.stepId || '';
  if (sid === 'step02_build_dataset') {
    return [
      { prop: 'id', label: '档案编号', width: 130 },
      { prop: 'name', label: '文物名称', ellipsis: true },
      { prop: 'category', label: '类别', width: 110 },
      { prop: 'era_stats', label: '年代', width: 100 },
      { prop: 'condition', label: '保存', width: 80 },
      { prop: 'risk_score', label: '风险', width: 70 },
    ];
  }
  if (sid === 'step06_prepare_boundaries') {
    return [
      { prop: 'name', label: '边界层', width: 120 },
      { prop: 'feature_count', label: '要素数', width: 90 },
      {
        prop: 'output_size_kb',
        label: '大小(KB)',
        width: 110,
        formatter: (r) => (r.output_size_kb != null ? String(r.output_size_kb) : '-'),
      },
      {
        prop: 'output_mtime',
        label: '更新时间',
        formatter: (r) => r.output_mtime || '-',
      },
    ];
  }
  // step01 / step03 / step04 / step05 共用
  return [
    { prop: 'id', label: '编号', width: 140 },
    { prop: 'name', label: '文件名', ellipsis: true },
    {
      prop: 'input_size_kb',
      label: '输入(KB)',
      width: 100,
      formatter: (r) => (r.input_size_kb != null ? String(r.input_size_kb) : '-'),
    },
    {
      prop: 'output_size_kb',
      label: '输出(KB)',
      width: 100,
      formatter: (r) => (r.output_size_kb != null ? String(r.output_size_kb) : '-'),
    },
  ];
});
</script>

<style scoped>
.items-drawer {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
}
.head {
  flex-shrink: 0;
  padding: 14px 18px;
  border-bottom: 1px solid var(--bd);
  display: flex;
  align-items: center;
  gap: 10px;
}
.title {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--t1);
  font-weight: 600;
  font-size: 14px;
}

.loading,
.empty {
  padding: 40px 0;
  text-align: center;
  color: var(--t2);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.body {
  flex: 1;
  padding: 8px 12px;
}

.grp-hdr {
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding-right: 12px;
}
.gname {
  font-weight: 600;
  color: var(--t1);
  min-width: 100px;
}
.gbar {
  flex: 1;
  min-width: 120px;
}
.gcount {
  font-size: 12px;
  color: var(--t2);
  font-family: "Cascadia Code", Consolas, monospace;
}
.gcount b {
  color: var(--t1);
}

.items-tbl {
  background: transparent !important;
  --el-table-bg-color: var(--bg2);
  --el-table-tr-bg-color: var(--bg2);
  --el-table-row-hover-bg-color: var(--bg3);
  --el-table-border-color: var(--bd);
  --el-table-header-bg-color: var(--bg3);
  --el-table-text-color: var(--t3);
  --el-table-header-text-color: var(--t2);
}

.grp-foot {
  height: 8px;
}

/* Element Plus collapse 深色兼容 */
:deep(.el-collapse),
:deep(.el-collapse-item__wrap),
:deep(.el-collapse-item__header) {
  background: transparent !important;
  border-color: var(--bd) !important;
  color: var(--t3) !important;
}
:deep(.el-collapse-item__content) {
  padding: 12px 4px 16px;
  color: var(--t3);
}
</style>
