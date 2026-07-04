<template>
  <div class="page-container dashboard">
    <div class="page-title">
      数据概览
      <span class="sub">
        <template v-if="stats?.last_updated">
          · 数据最后更新 {{ fmtTs(stats.last_updated) }}
        </template>
      </span>
      <div class="top-actions">
        <el-button plain :icon="Refresh" :loading="loading" @click="reload">
          刷新
        </el-button>
      </div>
    </div>

    <!-- 核心指标卡片 -->
    <el-row :gutter="12" class="stat-row">
      <el-col
        v-for="c in cards"
        :key="c.key"
        :xs="12"
        :sm="8"
        :md="4"
      >
        <div class="stat-card" @click="c.to && $router.push(c.to)">
          <div class="stat-icon" :style="{ color: c.color }">
            <el-icon :size="20"><component :is="c.icon" /></el-icon>
          </div>
          <div class="stat-main">
            <div class="stat-label">{{ c.label }}</div>
            <div class="stat-value" :style="{ color: c.color }">{{ c.value }}</div>
            <!-- total 卡片：副文案拆成 2 个链接；其他卡片：纯文本 -->
            <div v-if="c.key === 'total'" class="stat-sub">
              <a class="sub-link" @click.stop="$router.push('/relics?status=0')">
                草稿 {{ stats?.totals?.drafts ?? 0 }}
              </a>
              <span class="sub-sep">·</span>
              <a class="sub-link danger" @click.stop="$router.push('/relics?status=-1')">
                <el-icon class="sub-ic"><Delete /></el-icon>
                回收站 {{ stats?.totals?.deleted ?? 0 }}
              </a>
            </div>
            <div v-else class="stat-sub">{{ c.sub }}</div>
          </div>
        </div>
      </el-col>
    </el-row>

    <!-- 第一行图表：类别 + 级别 -->
    <el-row :gutter="12" class="chart-row">
      <el-col :xs="24" :md="12">
        <div class="chart-card">
          <div class="chart-head">
            <span>文物大类分布</span>
            <span class="chart-sub">GB/T 15420 国标六大类</span>
          </div>
          <div ref="donutCatRef" class="chart-body chart-h300" />
        </div>
      </el-col>
      <el-col :xs="24" :md="12">
        <div class="chart-card">
          <div class="chart-head">
            <span>保护级别分布</span>
            <span class="chart-sub">国保 / 省保 / 市保 / 县保 / 未定级</span>
          </div>
          <div ref="barRankRef" class="chart-body chart-h300" />
        </div>
      </el-col>
    </el-row>

    <!-- 第二行：乡镇 Top15 -->
    <el-row :gutter="12" class="chart-row">
      <el-col :span="24">
        <div class="chart-card">
          <div class="chart-head">
            <span>乡镇文物数 Top 15</span>
            <span class="chart-sub">点击条目跳转列表筛选</span>
          </div>
          <div ref="barTownshipRef" class="chart-body chart-h360" />
        </div>
      </el-col>
    </el-row>

    <!-- 管线健康：六步状态 + 上次运行时间 + 失败高亮 -->
    <el-row :gutter="12" class="chart-row">
      <el-col :span="24">
        <div class="chart-card pipeline-card">
          <div class="chart-head">
            <span>
              数据管线健康
              <el-tag
                v-if="pipelineHasError"
                size="small"
                type="danger"
                effect="dark"
                class="head-tag"
              >
                有失败
              </el-tag>
              <el-tag
                v-else-if="pipelineAnyRun"
                size="small"
                type="success"
                effect="dark"
                class="head-tag"
              >
                正常
              </el-tag>
            </span>
            <span class="chart-sub">最近一次各 step 运行状态 · 点击进入管线页</span>
            <router-link to="/pipeline" class="chart-link">去管线 →</router-link>
          </div>
          <div v-loading="pipelineLoading" class="pipeline-grid">
            <div
              v-for="s in pipelineSteps"
              :key="s.id"
              class="pipe-step"
              :class="pipeStepClass(s)"
              @click="goPipeline(s.id)"
            >
              <div class="pipe-step-head">
                <span class="pipe-ico">{{ s.icon }}</span>
                <span class="pipe-name">{{ s.name }}</span>
                <el-tag
                  size="small"
                  :type="pipeTagType(s)"
                  effect="plain"
                  class="pipe-status-tag"
                >
                  {{ pipeStatusText(s) }}
                </el-tag>
              </div>
              <el-progress
                :percentage="Math.round(s.progress)"
                :status="pipeProgressStatus(s)"
                :stroke-width="6"
                :show-text="false"
                class="pipe-progress"
              />
              <div class="pipe-meta">
                <span class="pipe-flow">{{ s.flow }}</span>
                <span class="pipe-pending" :class="{ 'has-pending': s.pending > 0 }">
                  待处理 {{ s.pending }}
                </span>
              </div>
              <div class="pipe-last">
                <template v-if="s.last_run?.started">
                  <el-icon class="pipe-last-ic"><Clock /></el-icon>
                  <span class="mono">{{ relativeDate(s.last_run.started) }}</span>
                </template>
                <template v-else-if="s.artifact_mtime">
                  <el-icon class="pipe-last-ic"><Document /></el-icon>
                  <span class="mono">{{ relativeDate(s.artifact_mtime) }}</span>
                </template>
                <template v-else>
                  <span class="muted">未运行</span>
                </template>
              </div>
            </div>
            <div v-if="!pipelineSteps.length && !pipelineLoading" class="pipeline-empty">
              管线状态不可用
            </div>
          </div>
        </div>
      </el-col>
    </el-row>

    <!-- 瓦片缓存：离线地图下载量 + 最近下载记录 -->
    <el-row :gutter="12" class="chart-row">
      <el-col :span="24">
        <div class="chart-card tile-card" v-loading="tilesLoading">
          <div class="chart-head">
            <span>
              离线瓦片缓存
              <el-tag
                v-if="tilesSummary && tilesSummary.totals.count > 0"
                size="small"
                type="success"
                effect="dark"
                class="head-tag"
              >
                {{ tilesSummary.totals.count }} 张 · {{ fmtMB(tilesSummary.totals.bytes) }}
              </el-tag>
              <el-tag
                v-else-if="tilesSummary"
                size="small"
                type="info"
                effect="dark"
                class="head-tag"
              >
                无缓存
              </el-tag>
            </span>
            <span class="chart-sub">
              在首页地图的"离线瓦片下载"面板里按县域或框选下载；此处展示全局缓存与下载历史
            </span>
            <a
              href="/#download"
              target="_blank"
              class="chart-link"
              @click.prevent="openMapDownload"
            >去地图下载 →</a>
          </div>

          <div class="tile-body">
            <!-- 左：各 provider 缓存体量 -->
            <div class="tile-col">
              <div class="tile-col-title">
                各瓦片源
                <span class="tile-sub">
                  最近一次：{{ relativeFromEpoch(tilesSummary?.last_finished_at) }}
                </span>
              </div>
              <div v-if="tilesProviderList.length" class="tile-prov-list">
                <div
                  v-for="p in tilesProviderList"
                  :key="p.key"
                  class="tile-prov-row"
                >
                  <span class="tp-name">{{ providerLabel(p.key) }}</span>
                  <span class="tp-spacer"></span>
                  <span class="tp-count">{{ p.count }} 张</span>
                  <span class="tp-sep">·</span>
                  <span class="tp-bytes">{{ fmtMB(p.bytes) }}</span>
                </div>
              </div>
              <div v-else class="tile-empty">尚未下载任何离线瓦片</div>
              <div class="tile-path">
                <el-icon><FolderOpened /></el-icon>
                <code>{{ tilesSummary?.cache_dir || '—' }}</code>
              </div>
            </div>

            <!-- 右：最近下载历史 -->
            <div class="tile-col">
              <div class="tile-col-title">
                最近下载记录
                <span class="tile-sub">{{ tilesSummary?.recent?.length || 0 }} 条</span>
              </div>
              <div v-if="tilesSummary?.recent?.length" class="tile-hist-list">
                <div
                  v-for="h in tilesSummary.recent"
                  :key="h.id"
                  class="tile-hist-row"
                  :class="{ err: h.status === 'error' }"
                >
                  <div class="th-head">
                    <span class="th-label">
                      <el-icon class="th-ic"><MapLocation /></el-icon>
                      {{ h.label || '手动框选范围' }}
                    </span>
                    <el-tag
                      size="small"
                      :type="h.status === 'done' ? 'success' : (h.status === 'error' ? 'danger' : 'primary')"
                      effect="plain"
                      class="th-tag"
                    >
                      {{ h.status === 'done' ? '完成' : (h.status === 'error' ? '失败' : '进行中') }}
                    </el-tag>
                  </div>
                  <div class="th-meta">
                    <span>Z{{ h.zooms.join(' · Z') }}</span>
                    <span class="dot-sep">·</span>
                    <span>{{ (h.providers || []).map(providerLabel).join(' / ') }}</span>
                  </div>
                  <div class="th-stats">
                    <span class="s-item">
                      新增 <b class="ok">{{ h.downloaded }}</b> 张
                    </span>
                    <span class="s-item">
                      命中 <b class="muted">{{ h.skipped }}</b>
                    </span>
                    <span v-if="h.failed" class="s-item">
                      失败 <b class="err">{{ h.failed }}</b>
                    </span>
                    <span class="s-item">{{ fmtMB(h.bytes) }}</span>
                    <span class="s-time">{{ relativeFromEpoch(h.finished_at || h.started_at) }}</span>
                  </div>
                </div>
              </div>
              <div v-else class="tile-empty">暂无下载历史</div>
            </div>
          </div>
        </div>
      </el-col>
    </el-row>

    <!-- 第三行：14 天审计趋势 + 最近活动 -->
    <el-row :gutter="12" class="chart-row">
      <el-col :xs="24" :lg="14">
        <div class="chart-card">
          <div class="chart-head">
            <span>最近 14 天变更趋势</span>
            <span class="chart-sub">基于审计日志聚合</span>
          </div>
          <div ref="lineAuditRef" class="chart-body chart-h280" />
        </div>
      </el-col>
      <el-col :xs="24" :lg="10">
        <div class="chart-card activity-card">
          <div class="chart-head">
            <span>最近活动</span>
            <router-link to="/audit" class="chart-link">查看全部 →</router-link>
          </div>
          <div class="activity-list">
            <div
              v-for="r in stats?.audit_recent || []"
              :key="r.id"
              class="activity-item"
              @click="goAudit(r.relic_code)"
            >
              <div class="act-left">
                <el-tag
                  size="small"
                  :type="actionType(r.action)"
                  effect="dark"
                  class="act-tag"
                >
                  {{ actionLabel(r.action) }}
                </el-tag>
                <span class="act-name">
                  {{ r.relic_name || r.relic_code || '—' }}
                </span>
              </div>
              <div class="act-right">
                <span class="act-actor">{{ r.actor || 'system' }}</span>
                <span class="act-ts">{{ relativeTs(r.ts) }}</span>
              </div>
            </div>
            <div v-if="!stats?.audit_recent?.length" class="activity-empty">
              暂无审计记录
            </div>
          </div>
        </div>
      </el-col>
    </el-row>

    <!-- 年代分布 + 来源 -->
    <el-row :gutter="12" class="chart-row">
      <el-col :xs="24" :md="14">
        <div class="chart-card">
          <div class="chart-head">
            <span>年代分布 Top 8</span>
            <span class="chart-sub">基于 era_stats 归并字段</span>
          </div>
          <div ref="barEraRef" class="chart-body chart-h260" />
        </div>
      </el-col>
      <el-col :xs="24" :md="10">
        <div class="chart-card">
          <div class="chart-head">
            <span>普查来源构成</span>
            <span class="chart-sub">三普在册 / 县级以上 / 四普新增</span>
          </div>
          <div ref="pieSearchRef" class="chart-body chart-h260" />
        </div>
      </el-col>
    </el-row>
  </div>
</template>

<script setup lang="ts">
import { useDashboard } from '@/composables/useDashboard';

const {
  loading,
  stats,
  pipelineSteps,
  pipelineLoading,
  tilesSummary,
  tilesLoading,
  donutCatRef,
  barRankRef,
  barTownshipRef,
  lineAuditRef,
  barEraRef,
  pieSearchRef,
  cards,
  reload,
  fmtMB,
  providerLabel,
  relativeFromEpoch,
  tilesProviderList,
  openMapDownload,
  pipelineHasError,
  pipelineAnyRun,
  pipeStatusText,
  pipeTagType,
  pipeProgressStatus,
  pipeStepClass,
  relativeDate,
  goPipeline,
  fmtTs,
  relativeTs,
  actionLabel,
  actionType,
  goAudit,
  Refresh,
  Delete,
  Clock,
  Document,
  FolderOpened,
  MapLocation,
} = useDashboard();
</script>

<style scoped src="../styles/dashboard.css"></style>
