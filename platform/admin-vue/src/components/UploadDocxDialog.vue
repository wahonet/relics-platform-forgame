<template>
  <el-dialog
    v-model="visible"
    title="上传 / 提取单个档案"
    width="560px"
    :close-on-click-modal="false"
    @closed="reset"
  >
    <el-alert
      type="info"
      :closable="false"
      show-icon
      title="说明"
      description="把一份 .docx 档案放到指定乡镇目录下。选『上传并提取』会立即触发 step01 让 AI 把它转成 Markdown；选『仅上传』则只拷贝文件，稍后再统一跑 step01。"
      class="tip"
    />

    <el-form :model="form" label-width="90px" class="form">
      <el-form-item label="所属乡镇">
        <el-select
          v-model="form.township"
          :loading="tLoading"
          placeholder="请选择乡镇"
          filterable
          style="width: 100%"
        >
          <el-option
            v-for="t in townships"
            :key="t.name"
            :label="`${t.name}（docx ${t.docx_count} · md ${t.md_count}）`"
            :value="t.name"
          />
        </el-select>
      </el-form-item>

      <el-form-item label="DOCX 文件">
        <el-upload
          drag
          :auto-upload="false"
          :show-file-list="false"
          accept=".docx"
          :on-change="onSelect"
          class="dropzone"
        >
          <el-icon :size="40" class="up-ico"><UploadFilled /></el-icon>
          <div class="drop-title">
            拖拽 .docx 到此，或 <em>点击选择</em>
          </div>
          <div v-if="form.file" class="picked">
            <el-icon><Document /></el-icon>
            {{ form.file.name }}
            <span class="size">{{ (form.file.size / 1024).toFixed(1) }} KB</span>
          </div>
          <div v-else class="drop-hint">单文件 · 仅接受 .docx 格式</div>
        </el-upload>
      </el-form-item>
    </el-form>

    <template #footer>
      <el-button @click="visible = false">取消</el-button>
      <el-button
        type="primary"
        plain
        :disabled="!canSubmit"
        :loading="submitting === 'upload'"
        @click="submit('upload')"
      >
        仅上传
      </el-button>
      <el-button
        type="primary"
        :disabled="!canSubmit"
        :loading="submitting === 'process'"
        @click="submit('process')"
      >
        <el-icon><Lightning /></el-icon>
        上传并提取
      </el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import type { UploadFile, UploadRawFile } from 'element-plus';
import { Document, Lightning, UploadFilled } from '@element-plus/icons-vue';
import { adminApi, type TownshipInfo } from '@/api/admin';

const props = defineProps<{
  modelValue: boolean;
  defaultTownship?: string;
}>();

const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'processed', taskId: string): void;
  (e: 'uploaded'): void;
}>();

const visible = ref(props.modelValue);
watch(
  () => props.modelValue,
  (v) => {
    visible.value = v;
    if (v) void loadTownships();
  },
);
watch(visible, (v) => emit('update:modelValue', v));

const tLoading = ref(false);
const townships = ref<TownshipInfo[]>([]);
const form = reactive({
  township: props.defaultTownship || '',
  file: null as File | null,
});
const submitting = ref<'upload' | 'process' | null>(null);

async function loadTownships() {
  tLoading.value = true;
  try {
    townships.value = await adminApi.townships();
    if (!form.township && townships.value.length) {
      form.township = townships.value[0].name;
    }
  } catch {
    // 拦截器已提示
  } finally {
    tLoading.value = false;
  }
}

function onSelect(file: UploadFile) {
  const raw = file.raw as UploadRawFile | undefined;
  if (!raw) return;
  if (!raw.name.toLowerCase().endsWith('.docx')) {
    ElMessage.error('仅支持 .docx 文件');
    return;
  }
  form.file = raw;
}

const canSubmit = computed(() => !!form.township && !!form.file && !submitting.value);

async function submit(kind: 'upload' | 'process') {
  if (!form.file || !form.township) return;
  const fd = new FormData();
  fd.append('file', form.file);
  fd.append('township', form.township);
  submitting.value = kind;
  try {
    if (kind === 'upload') {
      const res = await adminApi.uploadSingle(fd);
      ElMessage.success(res.message || '上传成功');
      emit('uploaded');
      visible.value = false;
    } else {
      const res = await adminApi.processSingle(fd);
      ElMessage.success('已启动提取任务');
      emit('processed', res.task_id);
      visible.value = false;
    }
  } catch {
    // 拦截器已提示
  } finally {
    submitting.value = null;
  }
}

function reset() {
  form.file = null;
}
</script>

<style scoped>
.tip {
  margin-bottom: 16px;
}
.form {
  margin-top: 8px;
}

.dropzone :deep(.el-upload-dragger) {
  background: var(--bg2);
  border: 1px dashed var(--bd);
  padding: 28px 16px;
  transition: all 0.2s;
}
.dropzone :deep(.el-upload-dragger:hover) {
  border-color: var(--accent);
  background: rgba(88, 166, 255, 0.04);
}

.up-ico {
  color: var(--accent);
}
.drop-title {
  font-size: 14px;
  color: var(--t1);
  margin-top: 8px;
}
.drop-title em {
  color: var(--accent);
  font-style: normal;
}
.drop-hint {
  font-size: 12px;
  color: var(--t2);
  margin-top: 4px;
}
.picked {
  margin-top: 10px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: var(--bg3);
  border-radius: 6px;
  color: var(--t1);
  font-size: 13px;
}
.picked .size {
  color: var(--t2);
  font-size: 12px;
  margin-left: 4px;
}
</style>
