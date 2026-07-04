<template>
  <div class="step" :class="stateCls">
    <div class="step-node">
      <span class="step-icon">{{ step.icon }}</span>
    </div>

    <el-card class="step-card" shadow="never">
      <div class="step-hdr">
        <div class="step-title">
          <div class="step-name">
            <span class="step-idx">{{ idxLabel }}</span>
            <span class="nm">{{ step.name }}</span>
            <span class="flow">{{ step.flow }}</span>
          </div>
          <div class="step-desc">{{ step.desc }}</div>
        </div>
        <el-tag :type="badgeType" size="small" effect="dark" class="badge">
          {{ badgeText }}
        </el-tag>
      </div>

      <div class="metrics">
        <div class="metric">
          <div class="m-num">{{ step.input.total }}</div>
          <div class="m-lbl">{{ step.input.label }}</div>
        </div>
        <div class="arrow">→</div>
        <div class="metric">
          <div class="m-num accent">{{ step.output.total }}</div>
          <div class="m-lbl">{{ step.output.label }}</div>
        </div>
      </div>

      <el-progress
        :percentage="Math.min(100, step.progress)"
        :color="progressColor"
        :stroke-width="8"
        :show-text="false"
        class="bar"
      />
      <div class="progress-meta">
        <span>
          进度 <b>{{ step.progress }}%</b>
        </span>
        <span>
          已完成 <b>{{ step.output.total }}</b>
          ·
          待处理
          <b :style="{ color: step.pending > 0 ? 'var(--yellow)' : 'var(--green)' }">
            {{ step.pending }}
          </b>
        </span>
      </div>

      <div v-if="extras.length" class="extras">
        <el-tag
          v-for="(e, i) in extras"
          :key="i"
          size="small"
          type="info"
          effect="plain"
          class="chip"
        >
          {{ e }}
        </el-tag>
      </div>

      <div class="actions">
        <el-button
          :type="running ? 'warning' : 'primary'"
          :disabled="!step.runnable || running"
          :loading="running"
          @click="$emit('run', step.id)"
        >
          <el-icon v-if="!running"><CaretRight /></el-icon>
          {{ running ? '运行中…' : (step.output.total > 0 ? '重新运行' : '开始运行') }}
        </el-button>
        <el-button plain @click="$emit('detail', step.id)">
          <el-icon><Document /></el-icon>
          查看详情
        </el-button>
        <el-button
          v-if="latestTaskId"
          plain
          @click="$emit('log', latestTaskId)"
        >
          <el-icon><Tickets /></el-icon>
          实时日志
        </el-button>
        <span class="mtime" v-if="step.artifact_mtime">
          产出更新于 {{ step.artifact_mtime }}
        </span>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { CaretRight, Document, Tickets } from '@element-plus/icons-vue';
import type { PipelineStep, TaskStatus } from '@/api/admin';

const props = defineProps<{
  step: PipelineStep;
  index: number;
  running: boolean;
  latestTaskId?: string | null;
}>();

defineEmits<{
  (e: 'run', stepId: string): void;
  (e: 'detail', stepId: string): void;
  (e: 'log', taskId: string): void;
}>();

const idxLabel = computed(() => String(props.index + 1).padStart(2, '0'));

type UiState = 'running' | 'done' | 'partial' | 'empty' | 'error';

const uiState = computed<UiState>(() => {
  if (props.running) return 'running';
  const lr = props.step.last_run?.status;
  if (lr === 'error') return 'error';
  if (props.step.progress >= 100) return 'done';
  if (props.step.progress > 0) return 'partial';
  return 'empty';
});

const stateCls = computed(() => `is-${uiState.value}`);

const badgeType = computed(() => {
  switch (uiState.value) {
    case 'done':
      return 'success';
    case 'running':
    case 'partial':
      return 'warning';
    case 'error':
      return 'danger';
    default:
      return 'info';
  }
});

const badgeText = computed(() => {
  switch (uiState.value) {
    case 'running':
      return '运行中';
    case 'done':
      return '已完成';
    case 'partial':
      return `部分完成`;
    case 'error':
      return '失败';
    default:
      return props.step.optional ? '可选 · 未运行' : '未运行';
  }
});

const progressColor = computed(() => {
  if (uiState.value === 'done') return '#3fb950';
  if (uiState.value === 'partial' || uiState.value === 'running') return '#d29922';
  return '#58a6ff';
});

const extras = computed(() => {
  const x = props.step.output.extra;
  if (!x) return [];
  return Object.entries(x).map(([k, v]) => `${k}: ${v}`);
});
</script>

<style scoped>
.step {
  position: relative;
  padding-left: 36px;
  margin-bottom: 18px;
}

.step-node {
  position: absolute;
  left: -4px;
  top: 14px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--bg2);
  border: 2px solid var(--bd);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  z-index: 2;
  transition: all 0.3s;
}
.step-icon {
  line-height: 1;
}

.step.is-done .step-node {
  border-color: var(--green);
  background: rgba(63, 185, 80, 0.1);
  box-shadow: 0 0 0 4px rgba(63, 185, 80, 0.08);
}
.step.is-partial .step-node {
  border-color: var(--yellow);
  background: rgba(210, 153, 34, 0.1);
  box-shadow: 0 0 0 4px rgba(210, 153, 34, 0.08);
}
.step.is-error .step-node {
  border-color: var(--red);
  background: rgba(248, 81, 73, 0.1);
}
.step.is-running .step-node {
  border-color: var(--yellow);
  animation: pulseNode 1.2s infinite;
}
@keyframes pulseNode {
  0%,
  100% {
    box-shadow: 0 0 0 4px rgba(210, 153, 34, 0.12);
  }
  50% {
    box-shadow: 0 0 0 10px rgba(210, 153, 34, 0);
  }
}

.step-card {
  background: var(--bg2) !important;
  border: 1px solid var(--bd) !important;
  transition: border-color 0.2s;
}
.step-card :deep(.el-card__body) {
  padding: 14px 18px;
}
.step-card:hover {
  border-color: var(--bd-a) !important;
}

.step-hdr {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  margin-bottom: 12px;
}
.step-title {
  flex: 1;
  min-width: 0;
}
.step-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--t1);
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.step-idx {
  font-size: 11px;
  color: var(--t2);
  background: var(--bg3);
  padding: 2px 8px;
  border-radius: 4px;
  letter-spacing: 0.5px;
  font-family: "Cascadia Code", Consolas, monospace;
}
.flow {
  font-size: 12px;
  color: var(--accent2);
  font-weight: 500;
}
.step-desc {
  font-size: 12px;
  color: var(--t2);
  margin-top: 4px;
  line-height: 1.5;
}
.badge {
  flex-shrink: 0;
}

.metrics {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 16px;
  align-items: center;
  margin-bottom: 12px;
}
.metric {
  text-align: center;
}
.m-num {
  font-size: 26px;
  font-weight: 700;
  color: var(--t1);
  line-height: 1.1;
}
.m-num.accent {
  color: var(--accent);
}
.m-lbl {
  font-size: 11px;
  color: var(--t2);
  margin-top: 4px;
}
.arrow {
  font-size: 22px;
  color: var(--t2);
  font-weight: 300;
}

.bar {
  margin-bottom: 6px;
}
.progress-meta {
  display: flex;
  justify-content: space-between;
  font-size: 11px;
  color: var(--t2);
  margin-bottom: 12px;
}
.progress-meta b {
  color: var(--t1);
}

.extras {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.chip {
  font-family: "Cascadia Code", Consolas, monospace;
}

.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.mtime {
  margin-left: auto;
  font-size: 11px;
  color: var(--t2);
}
</style>
