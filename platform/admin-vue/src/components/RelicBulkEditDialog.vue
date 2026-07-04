<template>
  <el-dialog
    :model-value="modelValue"
    title="批量修改字段"
    width="540px"
    :close-on-click-modal="false"
    append-to-body
    @update:model-value="(v: boolean) => emit('update:modelValue', v)"
    @close="handleClose"
  >
    <el-alert
      type="warning"
      :closable="false"
      show-icon
      :title="`将对已选的 ${codes.length} 条文物生效。只有勾选的字段会被写回，其它字段保持不变。`"
    />

    <el-form label-width="96px" label-position="right" class="bulk-form" @submit.prevent>
      <!-- 类别 -->
      <el-form-item>
        <template #label>
          <el-checkbox v-model="fields.category.enabled">类别</el-checkbox>
        </template>
        <el-select
          v-model="fields.category.value"
          :disabled="!fields.category.enabled"
          placeholder="选择新的类别"
          style="width: 100%"
        >
          <el-option
            v-for="c in dict.categories"
            :key="c.code"
            :label="`${c.code} ${c.label}`"
            :value="c.code"
          />
        </el-select>
      </el-form-item>

      <!-- 保护级别 -->
      <el-form-item>
        <template #label>
          <el-checkbox v-model="fields.rank.enabled">保护级别</el-checkbox>
        </template>
        <el-select
          v-model="fields.rank.value"
          :disabled="!fields.rank.enabled"
          placeholder="选择新的级别"
          style="width: 100%"
        >
          <el-option
            v-for="r in dict.ranks"
            :key="r.code"
            :label="r.label"
            :value="r.code"
          />
        </el-select>
      </el-form-item>

      <!-- 普查来源 -->
      <el-form-item>
        <template #label>
          <el-checkbox v-model="fields.search_type.enabled">普查来源</el-checkbox>
        </template>
        <el-select
          v-model="fields.search_type.value"
          :disabled="!fields.search_type.enabled"
          placeholder="选择普查来源"
          style="width: 100%"
          clearable
        >
          <el-option
            v-for="s in dict.searchTypes"
            :key="s.code"
            :label="s.label"
            :value="s.code"
          />
        </el-select>
      </el-form-item>

      <!-- 乡镇 -->
      <el-form-item>
        <template #label>
          <el-checkbox v-model="fields.township.enabled">乡镇</el-checkbox>
        </template>
        <el-input
          v-model="fields.township.value"
          :disabled="!fields.township.enabled"
          placeholder="填新的乡镇名"
        />
      </el-form-item>

      <!-- 年代（统计） -->
      <el-form-item>
        <template #label>
          <el-checkbox v-model="fields.era_stats.enabled">年代统计</el-checkbox>
        </template>
        <el-input
          v-model="fields.era_stats.value"
          :disabled="!fields.era_stats.enabled"
          placeholder="如 清 / 民国"
        />
      </el-form-item>
    </el-form>

    <template #footer>
      <div class="dialog-footer">
        <el-button @click="handleClose">取消</el-button>
        <el-button
          type="primary"
          :loading="saving"
          :disabled="enabledCount === 0"
          @click="submit"
        >
          应用到 {{ codes.length }} 条
        </el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { adminApi } from '@/api/admin';
import { useAuthStore } from '@/stores/auth';
import { useDictStore } from '@/stores/dict';

interface Props {
  modelValue: boolean;
  codes: string[];
}
const props = withDefaults(defineProps<Props>(), { codes: () => [] });
const emit = defineEmits<{
  (e: 'update:modelValue', v: boolean): void;
  (e: 'done'): void;
}>();

const dict = useDictStore();
const auth = useAuthStore();

interface FieldCell<T = string> {
  enabled: boolean;
  value: T;
}
const emptyFields = () => ({
  category:    { enabled: false, value: '0600' } as FieldCell,
  rank:        { enabled: false, value: '5' } as FieldCell,
  search_type: { enabled: false, value: '' } as FieldCell,
  township:    { enabled: false, value: '' } as FieldCell,
  era_stats:   { enabled: false, value: '' } as FieldCell,
});
const fields = reactive(emptyFields());

const saving = ref(false);

const enabledCount = computed(
  () => Object.values(fields).filter((f) => f.enabled).length,
);

watch(
  () => props.modelValue,
  async (open) => {
    if (!open) return;
    await dict.ensureLoaded();
    Object.assign(fields, emptyFields());
  },
);

async function submit() {
  const patch: Record<string, unknown> = {};
  for (const [k, f] of Object.entries(fields)) {
    if (!f.enabled) continue;
    if (k === 'search_type' && !f.value) {
      patch[k] = null;
    } else {
      patch[k] = f.value;
    }
  }
  if (Object.keys(patch).length === 0) {
    ElMessage.warning('请至少勾选一个字段');
    return;
  }
  try {
    await ElMessageBox.confirm(
      `即将对 ${props.codes.length} 条文物写入：\n` +
        Object.entries(patch)
          .map(([k, v]) => `  · ${labelOf(k)} → ${fmt(k, v)}`)
          .join('\n'),
      '确认批量修改',
      { type: 'warning', confirmButtonText: '确认写入', cancelButtonText: '取消' },
    );
  } catch {
    return;
  }

  saving.value = true;
  try {
    const r = await adminApi.bulkUpdateRelics(
      props.codes,
      patch,
      auth.username || 'admin',
    );
    summarize(r.updated ?? 0, r.not_found || [], r.failed || []);
    emit('done');
    emit('update:modelValue', false);
  } catch {
    // 拦截器已提示
  } finally {
    saving.value = false;
  }
}

function handleClose() {
  if (saving.value) return;
  emit('update:modelValue', false);
}

function labelOf(k: string): string {
  const m: Record<string, string> = {
    category: '类别',
    rank: '保护级别',
    search_type: '普查来源',
    township: '乡镇',
    era_stats: '年代统计',
  };
  return m[k] || k;
}
function fmt(k: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '(清空)';
  if (k === 'category') return `${v} ${dict.labelOf('category', String(v))}`;
  if (k === 'rank') return dict.labelOf('rank', String(v));
  if (k === 'search_type') return dict.labelOf('search_type', String(v));
  return String(v);
}

function summarize(
  ok: number,
  notFound: string[],
  failed: Array<{ code: string; error: string }>,
) {
  const parts = [`成功 ${ok}`];
  if (notFound.length) parts.push(`未找到 ${notFound.length}`);
  if (failed.length) parts.push(`失败 ${failed.length}`);
  const msg = parts.join(' · ');
  if (failed.length || notFound.length) {
    ElMessage.warning(msg);
    // 在控制台打印细节，方便定位
    // eslint-disable-next-line no-console
    console.warn('[bulk-update]', { notFound, failed });
  } else {
    ElMessage.success(msg);
  }
}
</script>

<style scoped>
.bulk-form {
  margin-top: 12px;
}
.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
