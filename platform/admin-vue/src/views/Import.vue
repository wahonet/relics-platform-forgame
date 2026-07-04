<template>
  <div class="page-container import-page">
    <div class="page-title">
      批量导入
      <span class="sub">CSV / JSON → DB · 支持 upsert 与 create_only</span>
    </div>

    <el-row :gutter="16">
      <el-col :xs="24" :lg="12">
        <el-card shadow="never" class="step-card">
          <template #header>
            <div class="card-title">
              <span class="num">1</span>
              选择文件与模式
            </div>
          </template>

          <el-alert
            type="info"
            :closable="false"
            show-icon
            title="格式说明"
          >
            <p>支持 UTF-8 编码的 <code>.csv</code> 或 JSON 数组。每条记录至少包含：</p>
            <ul class="hint-list">
              <li><code>code</code>（文物编号，必填）</li>
              <li><code>name</code>（名称，必填）</li>
              <li><code>lng</code>/<code>lat</code>（WGS-84 十进制度）</li>
              <li><code>category</code>（4 位编码 如 0300，也接受中文"古建筑"）</li>
              <li><code>rank</code>（'1'~'5'，也接受"省级"等别名）</li>
            </ul>
            <p class="tips">其他字段（township/era/brief/has_3d/…）可选，见下方模板。</p>
          </el-alert>

          <el-divider />

          <el-form label-position="top">
            <el-form-item label="导入模式">
              <el-radio-group v-model="mode">
                <el-radio value="upsert">
                  <div class="radio-title">upsert（推荐）</div>
                  <div class="radio-desc">按 code 匹配；已有则更新，不存在则创建</div>
                </el-radio>
                <el-radio value="create_only">
                  <div class="radio-title">仅新增</div>
                  <div class="radio-desc">已有 code 会被跳过，不会被覆盖</div>
                </el-radio>
              </el-radio-group>
            </el-form-item>

            <el-form-item label="文件">
              <el-upload
                ref="uploadRef"
                drag
                action=""
                :auto-upload="false"
                :limit="1"
                :on-change="onFileChange"
                :on-remove="onFileRemove"
                :on-exceed="onExceed"
                accept=".csv,.json"
                class="upload-zone"
              >
                <el-icon class="up-icon"><UploadFilled /></el-icon>
                <div class="up-text">把 .csv / .json 拖到此处，或 <em>点击选择</em></div>
                <template #tip>
                  <div class="up-tip">单次最多 10MB；大于 5000 条建议分批</div>
                </template>
              </el-upload>
            </el-form-item>

            <el-form-item>
              <el-button-group>
                <el-button :icon="Download" @click="downloadCsvTemplate">
                  下载 CSV 模板
                </el-button>
                <el-button :icon="Download" @click="downloadJsonTemplate">
                  下载 JSON 模板
                </el-button>
              </el-button-group>
              <el-button
                type="primary"
                :icon="Upload"
                :loading="uploading"
                :disabled="!pendingFile"
                style="margin-left: auto"
                @click="doImport"
              >
                开始导入
              </el-button>
            </el-form-item>
          </el-form>
        </el-card>
      </el-col>

      <el-col :xs="24" :lg="12">
        <el-card shadow="never" class="step-card">
          <template #header>
            <div class="card-title">
              <span class="num">2</span>
              导入结果
            </div>
          </template>

          <div v-if="!result && !uploading" class="empty-hint">
            <el-icon :size="32"><InfoFilled /></el-icon>
            <p>选好文件后点击"开始导入"，结果将显示在此处</p>
          </div>

          <div v-else-if="uploading" class="empty-hint">
            <el-icon class="is-loading" :size="28"><Loading /></el-icon>
            <p>正在处理，大文件请耐心等待…</p>
          </div>

          <div v-else-if="result" class="result">
            <el-row :gutter="8" class="metrics">
              <el-col :span="6">
                <div class="metric m-ok">
                  <div class="n">{{ result.created }}</div>
                  <div class="l">新建</div>
                </div>
              </el-col>
              <el-col :span="6">
                <div class="metric m-warn">
                  <div class="n">{{ result.updated }}</div>
                  <div class="l">更新</div>
                </div>
              </el-col>
              <el-col :span="6">
                <div class="metric m-skip">
                  <div class="n">{{ result.skipped }}</div>
                  <div class="l">跳过</div>
                </div>
              </el-col>
              <el-col :span="6">
                <div class="metric m-err">
                  <div class="n">{{ result.failed }}</div>
                  <div class="l">失败</div>
                </div>
              </el-col>
            </el-row>

            <div class="result-actions">
              <el-button :icon="Refresh" @click="reset">再来一次</el-button>
              <el-button type="primary" :icon="View" @click="goRelics">
                去文物列表
              </el-button>
            </div>

            <div v-if="result.errors.length" class="errors">
              <div class="errors-head">
                失败行（前 {{ result.errors.length }} 条）
                <el-button
                  size="small"
                  link
                  :icon="Download"
                  @click="downloadErrors"
                >
                  下载失败行
                </el-button>
              </div>
              <el-table :data="result.errors" size="small" border max-height="360">
                <el-table-column label="行号" prop="line" width="80" />
                <el-table-column label="编号" prop="code" width="160" />
                <el-table-column label="错误" prop="error" show-overflow-tooltip />
              </el-table>
            </div>
          </div>
        </el-card>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox, type UploadFile, type UploadInstance, type UploadRawFile } from 'element-plus';
import {
  Download,
  InfoFilled,
  Loading,
  Refresh,
  Upload,
  UploadFilled,
  View,
} from '@element-plus/icons-vue';
import { adminApi, type ImportResult } from '@/api/admin';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const auth = useAuthStore();

const mode = ref<'upsert' | 'create_only'>('upsert');
const pendingFile = ref<File | null>(null);
const uploadRef = ref<UploadInstance>();
const uploading = ref(false);
const result = ref<ImportResult | null>(null);

function onFileChange(uf: UploadFile) {
  const raw = uf.raw as UploadRawFile | undefined;
  if (!raw) return;
  if (raw.size > 10 * 1024 * 1024) {
    ElMessage.warning('单次最多 10MB，请拆分后再传');
    uploadRef.value?.clearFiles();
    pendingFile.value = null;
    return;
  }
  pendingFile.value = raw;
  result.value = null;
}
function onFileRemove() {
  pendingFile.value = null;
}
function onExceed() {
  ElMessage.warning('只能选择 1 个文件');
}

async function doImport() {
  if (!pendingFile.value) return;
  const confirmMsg =
    mode.value === 'upsert'
      ? '导入模式为 upsert，已有 code 会被覆盖并写入审计日志。是否继续？'
      : '导入模式为 create_only，已有 code 将被跳过。是否继续？';
  try {
    await ElMessageBox.confirm(confirmMsg, '确认导入', {
      type: 'warning',
      confirmButtonText: '开始导入',
      cancelButtonText: '取消',
    });
  } catch {
    return;
  }

  uploading.value = true;
  try {
    const resp = await adminApi.importRelics(
      pendingFile.value,
      mode.value,
      auth.username || 'admin',
    );
    result.value = resp;
    const total = resp.created + resp.updated + resp.skipped + resp.failed;
    if (resp.failed === 0) {
      ElMessage.success(`导入完成：${total} 行，全部成功`);
    } else {
      ElMessage.warning(
        `导入完成：成功 ${resp.created + resp.updated} 行，失败 ${resp.failed} 行`,
      );
    }
  } catch {
    // 拦截器已提示
  } finally {
    uploading.value = false;
  }
}

function reset() {
  uploadRef.value?.clearFiles();
  pendingFile.value = null;
  result.value = null;
}

function goRelics() {
  router.push('/relics');
}

// ── 模板下载 ─────────────────────────────────────
const TEMPLATE_HEADERS = [
  'code', 'name', 'category', 'rank', 'search_type',
  'lng', 'lat', 'alt', 'township', 'village', 'address',
  'era', 'era_stats', 'brief',
  'has_3d', 'has_pdf', 'has_photo', 'has_boundary',
];
const SAMPLE = {
  code: '410102-0001',
  name: '示例文物',
  category: '0300',
  rank: '4',
  search_type: '2',
  lng: 113.625,
  lat: 34.746,
  alt: 100,
  township: '示范镇',
  village: '示范村',
  address: '示范街 1 号',
  era: '清',
  era_stats: '清',
  brief: '示例简介',
  has_3d: false,
  has_pdf: false,
  has_photo: false,
  has_boundary: false,
};

function downloadCsvTemplate() {
  const bom = '\ufeff';
  const header = TEMPLATE_HEADERS.join(',');
  const row = TEMPLATE_HEADERS.map((k) => {
    const v = (SAMPLE as Record<string, unknown>)[k];
    if (v === undefined || v === null) return '';
    const s = String(v);
    return s.includes(',') || s.includes('"') ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',');
  const text = bom + header + '\n' + row + '\n';
  downloadBlob(text, 'relics_import_template.csv', 'text/csv;charset=utf-8');
}

function downloadJsonTemplate() {
  const text = JSON.stringify([SAMPLE], null, 2);
  downloadBlob(text, 'relics_import_template.json', 'application/json;charset=utf-8');
}

function downloadErrors() {
  if (!result.value?.errors.length) return;
  const header = 'line,code,error\n';
  const rows = result.value.errors
    .map((e) => {
      const err = e.error.replace(/"/g, '""');
      return `${e.line},"${e.code}","${err}"`;
    })
    .join('\n');
  downloadBlob('\ufeff' + header + rows, 'import_errors.csv', 'text/csv;charset=utf-8');
}

function downloadBlob(text: string, name: string, mime: string) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
</script>

<style scoped>
.import-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.step-card :deep(.el-card__header) {
  padding: 10px 16px;
}
.card-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
}
.num {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: var(--el-color-primary);
  color: #fff;
  font-size: 12px;
}
.hint-list {
  margin: 6px 0 0 18px;
  padding: 0;
  font-size: 13px;
  line-height: 1.8;
}
.hint-list code {
  padding: 1px 6px;
  border-radius: 3px;
  background: var(--el-fill-color);
  font-family: var(--el-font-family-mono, monospace);
  font-size: 12px;
}
.tips {
  margin: 6px 0 0;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.upload-zone :deep(.el-upload-dragger) {
  padding: 24px 0;
}
.up-icon {
  font-size: 44px;
  color: var(--el-color-primary);
}
.up-text {
  color: var(--el-text-color-regular);
  margin-top: 8px;
}
.up-text em {
  color: var(--el-color-primary);
  font-style: normal;
}
.up-tip {
  padding-top: 6px;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
.radio-title { font-weight: 600; }
.radio-desc {
  font-size: 12px;
  color: var(--el-text-color-secondary);
  margin-top: 2px;
}

.empty-hint {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 60px 0;
  color: var(--el-text-color-secondary);
}

.metrics { margin-bottom: 16px; }
.metric {
  padding: 14px 10px;
  border-radius: 8px;
  text-align: center;
  background: var(--el-fill-color-light);
  border: 1px solid var(--el-border-color-lighter);
}
.metric .n { font-size: 26px; font-weight: 700; line-height: 1.1; }
.metric .l { font-size: 12px; margin-top: 4px; color: var(--el-text-color-secondary); }
.m-ok  .n { color: #22c55e; }
.m-warn .n { color: #f59e0b; }
.m-skip .n { color: var(--el-text-color-regular); }
.m-err .n { color: #ef4444; }

.result-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}

.errors-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  margin-bottom: 8px;
}
</style>
