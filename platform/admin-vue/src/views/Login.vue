<template>
  <div class="login-wrap">
    <div class="login-bg" />
    <div class="login-card">
      <div class="login-header">
        <div class="login-logo">📚</div>
        <h1 class="login-title">文物平台</h1>
        <p class="login-sub">数据管理后台</p>
      </div>

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="top"
        size="large"
        @submit.prevent
      >
        <el-form-item label="用户名" prop="username">
          <el-input
            v-model="form.username"
            placeholder="请输入用户名"
            autocomplete="username"
            :prefix-icon="User"
          />
        </el-form-item>
        <el-form-item label="密码" prop="password">
          <el-input
            v-model="form.password"
            type="password"
            placeholder="默认模板密码 changeme"
            autocomplete="current-password"
            :prefix-icon="Lock"
            show-password
            @keyup.enter="onSubmit"
          />
        </el-form-item>
        <el-button
          type="primary"
          class="login-btn"
          size="large"
          :loading="loading"
          @click="onSubmit"
        >
          登录
        </el-button>
      </el-form>

      <div class="login-foot">
        <a href="/" target="_blank">← 返回地图</a>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import type { FormInstance, FormRules } from 'element-plus';
import { ElMessage } from 'element-plus';
import { User, Lock } from '@element-plus/icons-vue';
import { login } from '@/api/auth';
import { useAuthStore } from '@/stores/auth';

const router = useRouter();
const route = useRoute();
const auth = useAuthStore();

const formRef = ref<FormInstance>();
const loading = ref(false);
const form = reactive({ username: 'admin', password: '' });

const rules: FormRules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
};

async function onSubmit() {
  if (!formRef.value) return;
  const valid = await formRef.value.validate().catch(() => false);
  if (!valid) return;

  loading.value = true;
  try {
    const res = await login({ username: form.username, password: form.password });
    if (res.ok) {
      auth.setLoggedIn(form.username);
      ElMessage.success('登录成功');
      const redirect = (route.query.redirect as string) || '/dashboard';
      router.replace(redirect);
    }
  } catch {
    // 401 已由 http 拦截器 toast 出来
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.login-wrap {
  position: relative;
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: radial-gradient(
      1200px 800px at 20% 10%,
      rgba(88, 166, 255, 0.12),
      transparent 60%
    ),
    radial-gradient(1000px 600px at 80% 90%, rgba(188, 140, 255, 0.1), transparent 60%),
    var(--bg);
  overflow: hidden;
}
.login-bg {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(88, 166, 255, 0.05) 1px, transparent 1px),
    linear-gradient(90deg, rgba(88, 166, 255, 0.05) 1px, transparent 1px);
  background-size: 48px 48px;
  pointer-events: none;
}

.login-card {
  position: relative;
  width: 380px;
  padding: 36px 32px 28px;
  background: rgba(22, 27, 34, 0.85);
  border: 1px solid var(--bd);
  border-radius: 14px;
  backdrop-filter: blur(12px);
  box-shadow: 0 10px 48px rgba(0, 0, 0, 0.35);
}

.login-header {
  text-align: center;
  margin-bottom: 24px;
}
.login-logo {
  font-size: 38px;
  margin-bottom: 6px;
}
.login-title {
  font-size: 20px;
  font-weight: 600;
  letter-spacing: 4px;
  background: linear-gradient(90deg, var(--accent), var(--accent2));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  margin: 0;
}
.login-sub {
  margin: 6px 0 0;
  color: var(--t2);
  font-size: 13px;
  letter-spacing: 1px;
}

.login-btn {
  width: 100%;
  margin-top: 6px;
  letter-spacing: 4px;
}

.login-foot {
  margin-top: 18px;
  text-align: center;
  font-size: 12px;
  color: var(--t2);
}
</style>
