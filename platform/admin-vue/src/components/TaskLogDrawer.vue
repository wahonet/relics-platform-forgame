<template>
  <el-drawer
    v-model="visible"
    :size="560"
    direction="rtl"
    :with-header="false"
    :close-on-click-modal="false"
    @close="stopPoll"
  >
    <div class="log-drawer">
      <div class="log-head">
        <div class="title">
          <el-icon class="spin" v-if="detail?.status === 'running'"><Loading /></el-icon>
          <el-icon v-else-if="detail?.status === 'done'" class="ok"><CircleCheckFilled /></el-icon>
          <el-icon v-else-if="detail?.status === 'error'" class="err"><CircleCloseFilled /></el-icon>
          <el-icon v-else class="muted"><Clock /></el-icon>
          <div class="title-text">
            <div class="tname">
              {{ detail?.script || '任务日志' }}
              <el-tag v-if="detail" :type="statusType" size="small" effect="dark">
                {{ statusText }}
              </el-tag>
            </div>
            <div class="tmeta" v-if="detail">
              <span>{{ detail.started }}</span>
              <span v-if="detail.finished"> → {{ detail.finished }}</span>
              <span v-if="taskId" class="tid">#{{ taskId }}</span>
            </div>
          </div>
        </div>
        <el-button text @click="close">
          <el-icon :size="18"><Close /></el-icon>
        </el-button>
      </div>

      <div class="log-toolbar">
        <el-checkbox v-model="autoScroll" size="small">自动滚到底部</el-checkbox>
        <el-button
          v-if="detail"
          size="small"
          text
          @click="copyLog"
        >
          <el-icon><CopyDocument /></el-icon>
          复制日志
        </el-button>
        <span class="meta">共 {{ detail?.log?.length || 0 }} 行</span>
      </div>

      <div ref="logBoxRef" class="log-box">
        <div
          v-for="(line, i) in detail?.log || []"
          :key="i"
          class="log-line"
          :class="lineClass(line)"
        >
          {{ line }}
        </div>
        <div v-if="!detail?.log?.length" class="log-empty">
          {{ detail ? '任务已启动，等待输出…' : '等待任务信息…' }}
        </div>
      </div>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import {
  CircleCheckFilled,
  CircleCloseFilled,
  Clock,
  Close,
  CopyDocument,
  Loading,
} from '@element-plus/icons-vue';
import { adminApi, type TaskDetail, type TaskStatus } from '@/api/admin';

const props = defineProps<{
  modelValue: boolean;
  taskId: string | null;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'finished', taskId: string, status: TaskStatus): void;
}>();

const visible = ref(props.modelValue);
watch(
  () => props.modelValue,
  (v) => {
    visible.value = v;
    if (v && props.taskId) startPoll(props.taskId);
    if (!v) stopPoll();
  },
);
watch(visible, (v) => emit('update:modelValue', v));
watch(
  () => props.taskId,
  (v) => {
    if (v && visible.value) startPoll(v);
  },
);

const detail = ref<TaskDetail | null>(null);
const autoScroll = ref(true);
const logBoxRef = ref<HTMLElement>();
let timer: number | null = null;

function close() {
  visible.value = false;
}

const statusType = computed(() => {
  const s = detail.value?.status;
  if (s === 'done') return 'success';
  if (s === 'error') return 'danger';
  if (s === 'running') return 'warning';
  return 'info';
});
const statusText = computed(() => {
  const s = detail.value?.status;
  if (s === 'done') return '成功';
  if (s === 'error') return '失败';
  if (s === 'running') return '运行中';
  if (s === 'starting') return '启动中';
  return '等待';
});

function lineClass(line: string): string {
  if (/错误|失败|Error|Exception|Traceback/i.test(line)) return 'err';
  if (/警告|WARN|⚠/i.test(line)) return 'warn';
  if (/完成|成功|Done|✓/i.test(line)) return 'ok';
  return '';
}

async function tick(taskId: string) {
  try {
    const t = await adminApi.getTask(taskId);
    detail.value = t;
    if (autoScroll.value) {
      await nextTick();
      const el = logBoxRef.value;
      if (el) el.scrollTop = el.scrollHeight;
    }
    if (t.status === 'done' || t.status === 'error') {
      stopPoll();
      emit('finished', taskId, t.status);
    }
  } catch {
    // 拦截器已提示
  }
}

function startPoll(taskId: string) {
  stopPoll();
  detail.value = null;
  void tick(taskId);
  timer = window.setInterval(() => void tick(taskId), 1500);
}

function stopPoll() {
  if (timer != null) {
    clearInterval(timer);
    timer = null;
  }
}

async function copyLog() {
  const lines = detail.value?.log || [];
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    ElMessage.success('已复制到剪贴板');
  } catch {
    ElMessage.error('复制失败：当前浏览器不支持 Clipboard API');
  }
}
</script>

<style scoped>
.log-drawer {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
}

.log-head {
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
  gap: 10px;
}
.title .spin {
  color: var(--yellow);
  animation: spin 1s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.title .ok {
  color: var(--green);
}
.title .err {
  color: var(--red);
}
.title .muted {
  color: var(--t2);
}
.title-text {
  min-width: 0;
}
.tname {
  font-size: 14px;
  font-weight: 600;
  color: var(--t1);
  display: flex;
  align-items: center;
  gap: 8px;
}
.tmeta {
  font-size: 12px;
  color: var(--t2);
  margin-top: 2px;
}
.tid {
  font-family: "Cascadia Code", Consolas, monospace;
  margin-left: 8px;
  padding: 0 6px;
  background: var(--bg3);
  border-radius: 3px;
}

.log-toolbar {
  flex-shrink: 0;
  padding: 6px 18px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  background: var(--bg2);
  display: flex;
  align-items: center;
  gap: 14px;
  font-size: 12px;
  color: var(--t2);
}
.log-toolbar .meta {
  margin-left: auto;
}

.log-box {
  flex: 1;
  overflow-y: auto;
  padding: 12px 18px 24px;
  background: #0a0e13;
  font-family: "Cascadia Code", Consolas, "Microsoft YaHei", monospace;
  font-size: 12px;
  line-height: 1.7;
  color: var(--t3);
}
.log-line {
  white-space: pre-wrap;
  word-break: break-all;
}
.log-line.err {
  color: var(--red);
}
.log-line.warn {
  color: var(--yellow);
}
.log-line.ok {
  color: var(--green);
}
.log-empty {
  color: var(--t2);
  font-style: italic;
  text-align: center;
  padding: 30px 0;
}
</style>
