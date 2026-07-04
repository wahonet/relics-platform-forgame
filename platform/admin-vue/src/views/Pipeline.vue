<template>
  <div class="page-container pipe-page">
    <div class="page-title">
      数据管线
      <span class="sub">DOCX → Markdown → Dataset → 照片/图纸 → 日志 → 边界</span>
      <div class="top-actions">
        <el-button plain @click="refresh" :loading="loading">
          <el-icon><Refresh /></el-icon>
          刷新
        </el-button>
        <el-button type="primary" @click="uploadVisible = true">
          <el-icon><UploadFilled /></el-icon>
          上传档案
        </el-button>
      </div>
    </div>

    <!-- 概要指标 -->
    <el-row :gutter="12" class="summary">
      <el-col v-for="s in summary" :key="s.label" :xs="12" :sm="8" :md="6" :lg="4">
        <el-card class="sum-card" shadow="never">
          <div class="sum-lbl">{{ s.label }}</div>
          <div class="sum-val" :class="s.tone">{{ s.value }}</div>
          <div class="sum-sub">{{ s.sub }}</div>
        </el-card>
      </el-col>
    </el-row>

    <!-- 主布局：左侧流程图，右侧任务历史 -->
    <el-row :gutter="16" class="main-row">
      <el-col :xs="24" :lg="17">
        <div v-if="loading && !pipeline" class="loading-block">
          <el-icon class="is-loading" :size="20"><Loading /></el-icon>
          加载管线状态…
        </div>

        <div v-else-if="pipeline" class="pipeline-v">
          <PipelineStep
            v-for="(step, i) in pipeline.steps"
            :key="step.id"
            :step="step"
            :index="i"
            :running="isRunning(step.id)"
            :latest-task-id="latestTaskIdOf(step.id)"
            @run="onRun"
            @detail="onDetail"
            @log="openLog"
          />
        </div>
      </el-col>

      <el-col :xs="24" :lg="7">
        <el-card class="tasks-card" shadow="never">
          <div class="card-hdr">
            <el-icon><Tickets /></el-icon>
            <span class="card-title">任务历史</span>
            <el-button text size="small" @click="loadTasks">
              <el-icon><Refresh /></el-icon>
            </el-button>
          </div>

          <div v-if="!tasks.length" class="task-empty">暂无任务</div>
          <div v-else class="task-list">
            <div
              v-for="t in tasks"
              :key="t.task_id"
              class="task-item"
              :class="'is-' + t.status"
              @click="openLog(t.task_id)"
            >
              <div class="ti-top">
                <span class="ti-name">{{ t.script }}</span>
                <el-tag :type="taskTagType(t.status)" size="small" effect="dark">
                  {{ taskTagText(t.status) }}
                </el-tag>
              </div>
              <div class="ti-time">
                <span>{{ t.started }}</span>
                <span v-if="t.finished">→ {{ t.finished }}</span>
              </div>
              <div v-if="t.last_log" class="ti-log">{{ t.last_log }}</div>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <TaskLogDrawer
      v-model="logVisible"
      :task-id="currentTaskId"
      @finished="onTaskFinished"
    />
    <StepItemsDrawer
      v-model="itemsVisible"
      :step-id="currentStepId"
      :step-name="currentStepName"
    />
    <UploadDocxDialog
      v-model="uploadVisible"
      @processed="onUploadedAndProcessed"
      @uploaded="refresh"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { Loading, Refresh, Tickets, UploadFilled } from '@element-plus/icons-vue';
import {
  adminApi,
  type PipelineResp,
  type TaskStatus,
  type TaskSummary,
} from '@/api/admin';
import PipelineStep from '@/components/PipelineStep.vue';
import TaskLogDrawer from '@/components/TaskLogDrawer.vue';
import StepItemsDrawer from '@/components/StepItemsDrawer.vue';
import UploadDocxDialog from '@/components/UploadDocxDialog.vue';

const pipeline = ref<PipelineResp | null>(null);
const tasks = ref<TaskSummary[]>([]);
const loading = ref(false);

const logVisible = ref(false);
const currentTaskId = ref<string | null>(null);

const itemsVisible = ref(false);
const currentStepId = ref<string | null>(null);
const currentStepName = ref<string>('');

const uploadVisible = ref(false);

let refreshTimer: number | null = null;

onMounted(() => {
  void refresh();
  // 本页 15s 拉一次总体状态;单任务日志由 TaskLogDrawer 自行 1.5s 轮询。
  refreshTimer = window.setInterval(() => void refresh(), 15_000);
});
onBeforeUnmount(() => {
  if (refreshTimer != null) clearInterval(refreshTimer);
});

async function refresh() {
  loading.value = true;
  try {
    const [p, ts] = await Promise.all([adminApi.pipeline(), adminApi.listTasks(30)]);
    pipeline.value = p;
    tasks.value = ts;
  } catch {
    // 拦截器已提示
  } finally {
    loading.value = false;
  }
}

async function loadTasks() {
  try {
    tasks.value = await adminApi.listTasks(30);
  } catch {
    // 拦截器已提示
  }
}

// 找出指定 step 正在运行的任务或最近一次任务,用于按钮高亮与打开日志。
function isRunning(stepId: string): boolean {
  return tasks.value.some(
    (t) => t.script === stepId && (t.status === 'running' || t.status === 'starting'),
  );
}
function latestTaskIdOf(stepId: string): string | null {
  const related = tasks.value
    .filter((t) => t.script === stepId)
    .sort((a, b) => (a.started < b.started ? 1 : -1));
  return related[0]?.task_id || null;
}

// ── 概要统计 ────────────────────────────────────────
const summary = computed(() => {
  const steps = pipeline.value?.steps || [];
  const total = steps.length;
  const done = steps.filter((s) => s.progress >= 100).length;
  const running = steps.filter((s) => isRunning(s.id)).length;
  const pending = steps.reduce((acc, s) => acc + (s.pending || 0), 0);

  const step02 = steps.find((s) => s.id === 'step02_build_dataset');
  const relicsTotal = step02?.output.total ?? 0;

  return [
    { label: '步骤完成', value: `${done} / ${total}`, sub: '管线进度', tone: 'accent' },
    { label: '运行中', value: running, sub: '正在执行的步骤', tone: running > 0 ? 'yellow' : '' },
    { label: '待处理', value: pending, sub: '所有步骤累计', tone: pending > 0 ? 'yellow' : 'green' },
    { label: '文物记录', value: relicsTotal, sub: 'step02 产出条数', tone: 'accent' },
    { label: '任务总数', value: tasks.value.length, sub: '历史记录', tone: '' },
  ];
});

// ── 交互 ────────────────────────────────────────────
async function onRun(stepId: string) {
  const running = isRunning(stepId);
  if (running) return;
  try {
    await ElMessageBox.confirm(
      `确认运行 ${stepId}？脚本会在后端异步执行，结束前请勿重复触发。`,
      '运行确认',
      { type: 'info' },
    );
  } catch {
    return;
  }
  try {
    const res = await adminApi.runScript(stepId);
    ElMessage.success(`任务 ${res.task_id} 已启动`);
    currentTaskId.value = res.task_id;
    logVisible.value = true;
    void loadTasks();
  } catch {
    // 拦截器已提示
  }
}

function onDetail(stepId: string) {
  currentStepId.value = stepId;
  currentStepName.value =
    pipeline.value?.steps.find((s) => s.id === stepId)?.name || stepId;
  itemsVisible.value = true;
}

function openLog(taskId: string) {
  currentTaskId.value = taskId;
  logVisible.value = true;
}

function onTaskFinished(_taskId: string, status: TaskStatus) {
  if (status === 'done') ElMessage.success('任务完成');
  else if (status === 'error') ElMessage.error('任务失败，详见日志');
  void refresh();
}

function onUploadedAndProcessed(taskId: string) {
  currentTaskId.value = taskId;
  logVisible.value = true;
  void refresh();
}

// ── 任务状态映射 ────────────────────────────────────
function taskTagType(s: TaskStatus) {
  if (s === 'done') return 'success';
  if (s === 'error') return 'danger';
  if (s === 'running' || s === 'starting') return 'warning';
  return 'info';
}
function taskTagText(s: TaskStatus) {
  if (s === 'done') return '成功';
  if (s === 'error') return '失败';
  if (s === 'running') return '运行中';
  if (s === 'starting') return '启动中';
  return s;
}
</script>

<style scoped>
.pipe-page {
  padding: 20px 24px 40px;
}
.page-title {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 16px;
}
.page-title .sub {
  font-size: 12px;
  color: var(--t2);
  font-weight: 400;
}
.top-actions {
  margin-left: auto;
  display: flex;
  gap: 8px;
}

.summary {
  margin-bottom: 18px;
}
.sum-card {
  background: var(--bg2) !important;
  border: 1px solid var(--bd) !important;
}
.sum-card :deep(.el-card__body) {
  padding: 12px 14px;
}
.sum-lbl {
  font-size: 11px;
  color: var(--t2);
}
.sum-val {
  font-size: 24px;
  font-weight: 700;
  color: var(--t1);
  line-height: 1.2;
  margin: 2px 0;
}
.sum-val.accent {
  color: var(--accent);
}
.sum-val.green {
  color: var(--green);
}
.sum-val.yellow {
  color: var(--yellow);
}
.sum-sub {
  font-size: 11px;
  color: var(--t2);
}

.main-row {
  align-items: flex-start;
}

/* 竖排流程图 */
.pipeline-v {
  position: relative;
  padding-left: 20px;
}
.pipeline-v::before {
  content: '';
  position: absolute;
  left: 16px;
  top: 12px;
  bottom: 12px;
  width: 2px;
  background: linear-gradient(
    180deg,
    var(--bd) 0%,
    rgba(88, 166, 255, 0.35) 50%,
    var(--bd) 100%
  );
  z-index: 0;
}

.loading-block {
  padding: 60px 0;
  text-align: center;
  color: var(--t2);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

/* 任务历史 */
.tasks-card {
  background: var(--bg2) !important;
  border: 1px solid var(--bd) !important;
  position: sticky;
  top: 12px;
}
.tasks-card :deep(.el-card__body) {
  padding: 0;
}
.card-hdr {
  padding: 12px 14px;
  border-bottom: 1px solid var(--bd);
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--t1);
  font-weight: 600;
  font-size: 14px;
}
.card-title {
  flex: 1;
}

.task-list {
  max-height: calc(100vh - 320px);
  overflow-y: auto;
  padding: 6px;
}
.task-empty {
  padding: 40px 0;
  text-align: center;
  color: var(--t2);
  font-size: 13px;
}

.task-item {
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.15s;
  margin-bottom: 4px;
}
.task-item:hover {
  background: var(--bg3);
  border-color: var(--bd);
}
.task-item.is-running,
.task-item.is-starting {
  background: rgba(210, 153, 34, 0.06);
  border-color: rgba(210, 153, 34, 0.3);
}
.task-item.is-error {
  background: rgba(248, 81, 73, 0.04);
  border-color: rgba(248, 81, 73, 0.25);
}
.ti-top {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ti-name {
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  color: var(--t1);
  font-family: "Cascadia Code", Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ti-time {
  font-size: 11px;
  color: var(--t2);
  margin-top: 4px;
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.ti-log {
  font-size: 11px;
  color: var(--t2);
  margin-top: 4px;
  font-family: "Cascadia Code", Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.75;
}
</style>
