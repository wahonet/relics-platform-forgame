<template>
  <el-container class="app-layout">
    <el-aside :width="collapsed ? '64px' : '220px'" class="app-aside">
      <div class="brand" :class="{ mini: collapsed }">
        <span class="brand-logo">📚</span>
        <span v-if="!collapsed" class="brand-name">文物平台后台</span>
      </div>
      <el-menu
        :default-active="route.path"
        :collapse="collapsed"
        :collapse-transition="false"
        background-color="transparent"
        text-color="var(--t3)"
        active-text-color="var(--accent)"
        router
        class="app-menu"
      >
        <el-menu-item
          v-for="item in menus"
          :key="item.path"
          :index="item.path"
        >
          <el-icon><component :is="iconFor(item.icon)" /></el-icon>
          <template #title>{{ item.title }}</template>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-container>
      <el-header class="app-header">
        <el-button text class="collapse-btn" @click="collapsed = !collapsed">
          <el-icon :size="18">
            <Expand v-if="collapsed" />
            <Fold v-else />
          </el-icon>
        </el-button>

        <el-breadcrumb :separator-icon="ArrowRight" class="crumb">
          <el-breadcrumb-item :to="{ path: '/dashboard' }">首页</el-breadcrumb-item>
          <el-breadcrumb-item v-if="currentTitle">{{ currentTitle }}</el-breadcrumb-item>
        </el-breadcrumb>

        <div class="spacer" />

        <el-link
          type="primary"
          :underline="false"
          href="/"
          target="_blank"
          class="to-map"
        >
          <el-icon><MapLocation /></el-icon>
          <span>返回地图</span>
        </el-link>

        <el-dropdown>
          <span class="user">
            <el-avatar :size="28" class="avatar">
              {{ (auth.username || 'A').slice(0, 1).toUpperCase() }}
            </el-avatar>
            <span class="uname">{{ auth.username || '管理员' }}</span>
            <el-icon><ArrowDown /></el-icon>
          </span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item @click="onLogout">
                <el-icon><SwitchButton /></el-icon>
                退出登录
              </el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </el-header>

      <el-main class="app-main">
        <router-view v-slot="{ Component }">
          <transition name="fade" mode="out-in">
            <component :is="Component" />
          </transition>
        </router-view>
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import {
  DataBoard,
  Connection,
  Collection,
  Upload,
  Document,
  Expand,
  Fold,
  ArrowDown,
  ArrowRight,
  SwitchButton,
  MapLocation,
} from '@element-plus/icons-vue';
import { useAuthStore } from '@/stores/auth';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const collapsed = ref(false);

const menus = [
  { path: '/dashboard', title: '数据概览', icon: 'DataBoard' },
  { path: '/pipeline', title: '数据管线', icon: 'Connection' },
  { path: '/relics', title: '文物数据', icon: 'Collection' },
  { path: '/import', title: '批量导入', icon: 'Upload' },
  { path: '/audit', title: '审计日志', icon: 'Document' },
];

const iconMap: Record<string, unknown> = {
  DataBoard,
  Connection,
  Collection,
  Upload,
  Document,
};

function iconFor(name?: string) {
  return name ? iconMap[name] : DataBoard;
}

const currentTitle = computed(() => {
  const m = menus.find((x) => x.path === route.path);
  return m?.title || '';
});

function onLogout() {
  auth.clear();
  ElMessage.success('已退出登录');
  router.replace('/login');
}
</script>

<style scoped>
.app-layout {
  height: 100vh;
  background: var(--bg);
}

.app-aside {
  background: var(--bg2);
  border-right: 1px solid var(--bd);
  transition: width 0.25s ease;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
}

.brand {
  height: 56px;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 18px;
  border-bottom: 1px solid var(--bd);
  white-space: nowrap;
}
.brand.mini {
  padding: 0;
  justify-content: center;
}
.brand-logo {
  font-size: 22px;
}
.brand-name {
  font-weight: 600;
  letter-spacing: 2px;
  background: linear-gradient(90deg, var(--accent), var(--accent2));
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
}

.app-menu {
  flex: 1;
  border-right: none;
  padding-top: 6px;
}
.app-menu :deep(.el-menu-item) {
  border-radius: 6px;
  margin: 2px 8px;
  height: 42px;
  line-height: 42px;
}
.app-menu :deep(.el-menu-item.is-active) {
  background: rgba(88, 166, 255, 0.1);
}

.app-header {
  height: 56px;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 0 18px;
  background: var(--bg2);
  border-bottom: 1px solid var(--bd);
}
.collapse-btn {
  color: var(--t2);
}
.crumb :deep(.el-breadcrumb__inner) {
  color: var(--t2);
}
.crumb :deep(.el-breadcrumb__item:last-child .el-breadcrumb__inner) {
  color: var(--t1);
  font-weight: 500;
}
.spacer {
  flex: 1;
}
.to-map {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
}
.user {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  padding: 4px 10px;
  border-radius: 6px;
  color: var(--t2);
  transition: all 0.2s;
}
.user:hover {
  background: var(--bg3);
  color: var(--t1);
}
.avatar {
  background: linear-gradient(135deg, var(--accent), var(--purple));
  color: #fff;
  font-weight: 600;
}
.uname {
  font-size: 13px;
}

.app-main {
  padding: 0;
  background: var(--bg);
  overflow-y: auto;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
