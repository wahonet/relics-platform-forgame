import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import * as echarts from 'echarts';
import type { EChartsOption } from 'echarts';
import {
  Clock,
  Collection,
  Delete,
  Document,
  DocumentCopy,
  FolderOpened,
  MapLocation,
  PictureFilled,
  Refresh,
  Star,
  VideoCamera,
} from '@element-plus/icons-vue';
import { adminApi, type PipelineStep, type StatsOverview, type TilesSummary } from '@/api/admin';

export function useDashboard() {
  const router = useRouter();

  const loading = ref(false);
  const stats = ref<StatsOverview | null>(null);
  const pipelineSteps = ref<PipelineStep[]>([]);
  const pipelineLoading = ref(false);
  const tilesSummary = ref<TilesSummary | null>(null);
  const tilesLoading = ref(false);

  // ── 图表 DOM refs ────────────────────────────
  const donutCatRef = ref<HTMLDivElement>();
  const barRankRef = ref<HTMLDivElement>();
  const barTownshipRef = ref<HTMLDivElement>();
  const lineAuditRef = ref<HTMLDivElement>();
  const barEraRef = ref<HTMLDivElement>();
  const pieSearchRef = ref<HTMLDivElement>();

  const charts: echarts.ECharts[] = [];

  // ── 深色主题,配色与主图一致 ─────────────────
  const TEXT = '#c9d1d9';
  const TEXT_DIM = '#8b949e';
  const LINE = 'rgba(88, 166, 255, 0.15)';
  const PALETTE = ['#58a6ff', '#3fb950', '#d29922', '#bc8cff', '#f85149', '#79c0ff', '#ffd700'];

  function baseOpts(): Partial<EChartsOption> {
    return {
      backgroundColor: 'transparent',
      color: PALETTE,
      textStyle: { color: TEXT, fontFamily: 'inherit' },
      tooltip: {
        backgroundColor: 'rgba(22, 27, 34, 0.96)',
        borderColor: 'rgba(88, 166, 255, 0.3)',
        textStyle: { color: TEXT },
      },
      grid: { left: 40, right: 20, top: 30, bottom: 30, containLabel: true },
    };
  }

  // ── 核心指标 ─────────────────────────────────
  const cards = computed(() => {
    const t = stats.value?.totals;
    const ranks = stats.value?.by_rank || [];
    const key1 = ranks.find((r) => r.code === '1')?.count || 0;
    const key2 = ranks.find((r) => r.code === '2')?.count || 0;
    const total = t?.total || 0;
    const photoRate = total > 0 ? Math.round(((t?.has_photo || 0) / total) * 100) : 0;

    return [
      {
        key: 'total', label: '文物总数', value: total,
        sub: t ? `草稿 ${t.drafts} · 已删 ${t.deleted}` : '—',
        icon: Collection, color: '#58a6ff', to: '/relics',
      },
      {
        key: 'topLv', label: '国 / 省级', value: key1 + key2,
        sub: `国保 ${key1} · 省保 ${key2}`,
        icon: Star, color: '#ffd700', to: '/relics?rank=1,2',
      },
      {
        key: '3d', label: '3D 模型', value: t?.has_3d ?? 0,
        sub: total > 0 ? `${pct(t?.has_3d, total)}% 覆盖` : '—',
        icon: VideoCamera, color: '#bc8cff', to: '',
      },
      {
        key: 'photo', label: '照片覆盖', value: `${photoRate}%`,
        sub: t ? `${t.has_photo} / ${total}` : '—',
        icon: PictureFilled, color: '#3fb950', to: '',
      },
      {
        key: 'pdf', label: '档案 PDF', value: t?.has_pdf ?? 0,
        sub: total > 0 ? `${pct(t?.has_pdf, total)}% 覆盖` : '—',
        icon: DocumentCopy, color: '#d29922', to: '',
      },
      {
        key: 'poly', label: '已描边界', value: t?.has_boundary ?? 0,
        sub: total > 0 ? `${pct(t?.has_boundary, total)}% 覆盖` : '—',
        icon: MapLocation, color: '#f85149', to: '',
      },
    ];
  });

  function pct(n: number | undefined, total: number): number {
    if (!n || !total) return 0;
    return Math.round((n / total) * 100);
  }

  // ── 加载 + 渲染 ─────────────────────────────
  async function reload() {
    loading.value = true;
    pipelineLoading.value = true;
    tilesLoading.value = true;
    try {
      // stats / pipeline / tiles 并行拉取;图表在 stats 返回后再画。
      const [s] = await Promise.all([
        adminApi.statsOverview().catch(() => null),
        adminApi.pipeline()
          .then((r) => { pipelineSteps.value = r.steps || []; })
          .catch(() => { pipelineSteps.value = []; })
          .finally(() => { pipelineLoading.value = false; }),
        adminApi.tilesSummary(10)
          .then((r) => { tilesSummary.value = r; })
          .catch(() => { tilesSummary.value = null; })
          .finally(() => { tilesLoading.value = false; }),
      ]);
      stats.value = s;
      await nextTick();
      renderCharts();
    } finally {
      loading.value = false;
    }
  }

  // ── 瓦片缓存卡片:格式化工具 ──────────────────
  function fmtMB(bytes: number | undefined): string {
    if (!bytes) return '0 MB';
    const mb = bytes / 1024 / 1024;
    if (mb >= 1024) return (mb / 1024).toFixed(2) + ' GB';
    if (mb >= 100) return mb.toFixed(0) + ' MB';
    if (mb >= 10) return mb.toFixed(1) + ' MB';
    return mb.toFixed(2) + ' MB';
  }
  function providerLabel(p: string): string {
    const m: Record<string, string> = {
      arcgis_sat: '卫星 · ArcGIS',
      osm: '矢量 · OSM',
      gaode_sat: '卫星 · 高德',
      gaode_vec: '矢量 · 高德',
      gaode_anno: '注记 · 高德',
    };
    return m[p] || p;
  }
  function relativeFromEpoch(sec: number | null | undefined): string {
    if (!sec) return '—';
    const diff = (Date.now() / 1000) - sec;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
    const d = new Date(sec * 1000);
    return `${d.getMonth() + 1}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  const tilesProviderList = computed(() => {
    const p = tilesSummary.value?.providers || {};
    return Object.keys(p).sort().map((k) => ({ key: k, ...p[k] }));
  });

  function openMapDownload() {
    // 主图首页带有全局 toggleDownloadPanel(),直接新开 / 即可。
    window.open('/', '_blank');
  }

  // ── 管线健康展示 ────────────────────────────
  const pipelineHasError = computed(() =>
    pipelineSteps.value.some((s) => s.last_run?.status === 'error'),
  );
  const pipelineAnyRun = computed(() =>
    pipelineSteps.value.some((s) => (s.progress ?? 0) > 0),
  );

  function pipeStatusText(s: PipelineStep): string {
    if (s.last_run?.status === 'running') return '运行中';
    if (s.last_run?.status === 'error') return '失败';
    if (s.pending > 0) return '待处理';
    if (s.progress >= 99.5) return '完成';
    if (s.progress > 0) return '进行中';
    return '未跑';
  }
  function pipeTagType(s: PipelineStep): 'success' | 'warning' | 'danger' | 'info' | 'primary' {
    if (s.last_run?.status === 'running') return 'primary';
    if (s.last_run?.status === 'error') return 'danger';
    if (s.progress >= 99.5) return 'success';
    if (s.pending > 0) return 'warning';
    return 'info';
  }
  function pipeProgressStatus(s: PipelineStep): '' | 'success' | 'exception' | 'warning' {
    if (s.last_run?.status === 'error') return 'exception';
    if (s.progress >= 99.5) return 'success';
    if (s.pending > 0) return 'warning';
    return '';
  }
  function pipeStepClass(s: PipelineStep): Record<string, boolean> {
    return {
      'step-error': s.last_run?.status === 'error',
      'step-running': s.last_run?.status === 'running',
      'step-done': s.progress >= 99.5 && s.last_run?.status !== 'error',
      'step-pending': s.pending > 0 && s.last_run?.status !== 'error',
    };
  }
  function relativeDate(s: string): string {
    if (!s) return '—';
    const t = new Date(s.replace(' ', 'T')).getTime();
    if (isNaN(t)) return s;
    const now = Date.now();
    const diff = (now - t) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
    return s.slice(5, 16);
  }
  function goPipeline(stepId: string) {
    router.push({ path: '/pipeline', query: { step: stepId } });
  }

  function renderCharts() {
    if (!stats.value) return;
    renderDonutCategory();
    renderBarRank();
    renderBarTownship();
    renderLineAudit();
    renderBarEra();
    renderPieSearch();
  }

  function mountChart(el: HTMLDivElement | undefined, opt: EChartsOption): echarts.ECharts | null {
    if (!el) return null;
    // 复用已有实例,切数据时直接 setOption 不重建。
    let inst = echarts.getInstanceByDom(el);
    if (!inst) {
      inst = echarts.init(el);
      charts.push(inst);
    }
    inst.setOption(opt, true);
    return inst;
  }

  // 类别环形图。
  function renderDonutCategory() {
    const data = (stats.value?.by_category || [])
      .filter((d) => d.count > 0)
      .map((d) => ({ name: d.label, value: d.count, code: d.code }));

    const inst = mountChart(donutCatRef.value, {
      ...baseOpts(),
      tooltip: { ...baseOpts().tooltip, trigger: 'item', formatter: '{b}<br/>{c} 条 ({d}%)' },
      legend: {
        orient: 'vertical', right: 10, top: 'middle',
        textStyle: { color: TEXT_DIM, fontSize: 12 },
        itemWidth: 10, itemHeight: 10,
      },
      series: [
        {
          type: 'pie', radius: ['45%', '72%'], center: ['35%', '50%'],
          avoidLabelOverlap: true, minAngle: 2,
          itemStyle: { borderColor: '#0d1117', borderWidth: 2 },
          label: { show: false },
          emphasis: { label: { show: true, formatter: '{b}\n{c}', fontSize: 13, color: TEXT } },
          data,
        },
      ],
    });

    inst?.off('click');
    inst?.on('click', (p: any) => {
      if (p?.data?.code) router.push({ path: '/relics', query: { category: p.data.code } });
    });
  }

  // 保护级别柱状。
  function renderBarRank() {
    const rows = stats.value?.by_rank || [];
    const SHORT: Record<string, string> = { '1': '国保', '2': '省保', '3': '市保', '4': '县保', '5': '未定级' };
    const RANK_COLOR: Record<string, string> = {
      '1': '#f85149', '2': '#d29922', '3': '#58a6ff', '4': '#3fb950', '5': '#8b949e',
    };

    const inst = mountChart(barRankRef.value, {
      ...baseOpts(),
      tooltip: { ...baseOpts().tooltip, trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: {
        type: 'category',
        data: rows.map((r) => SHORT[r.code] || r.label),
        axisLabel: { color: TEXT_DIM },
        axisLine: { lineStyle: { color: LINE } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: TEXT_DIM },
        splitLine: { lineStyle: { color: LINE } },
      },
      series: [
        {
          type: 'bar', barMaxWidth: 46,
          data: rows.map((r) => ({
            value: r.count, name: SHORT[r.code] || r.label, code: r.code,
            itemStyle: { color: RANK_COLOR[r.code] || '#58a6ff', borderRadius: [4, 4, 0, 0] },
          })),
          label: { show: true, position: 'top', color: TEXT, fontSize: 12 },
        },
      ],
    });

    inst?.off('click');
    inst?.on('click', (p: any) => {
      if (p?.data?.code) router.push({ path: '/relics', query: { rank: p.data.code } });
    });
  }

  // 乡镇 Top15 横向条形。
  function renderBarTownship() {
    const rows = [...(stats.value?.by_township_top || [])].reverse();

    const inst = mountChart(barTownshipRef.value, {
      ...baseOpts(),
      grid: { left: 110, right: 30, top: 10, bottom: 20, containLabel: false },
      tooltip: { ...baseOpts().tooltip, trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: {
        type: 'value',
        axisLabel: { color: TEXT_DIM },
        splitLine: { lineStyle: { color: LINE } },
      },
      yAxis: {
        type: 'category',
        data: rows.map((r) => r.name),
        axisLabel: { color: TEXT_DIM, fontSize: 12 },
        axisLine: { lineStyle: { color: LINE } },
      },
      series: [
        {
          type: 'bar', barMaxWidth: 18,
          data: rows.map((r) => ({
            value: r.count, name: r.name,
            itemStyle: {
              color: {
                type: 'linear' as const, x: 0, y: 0, x2: 1, y2: 0,
                colorStops: [{ offset: 0, color: '#1f6feb' }, { offset: 1, color: '#58a6ff' }],
              },
              borderRadius: [0, 4, 4, 0],
            },
          })),
          label: { show: true, position: 'right', color: TEXT, fontSize: 11 },
        },
      ],
    });

    inst?.off('click');
    inst?.on('click', (p: any) => {
      if (p?.data?.name) router.push({ path: '/relics', query: { township: p.data.name } });
    });
  }

  // 近 14 天审计折线。
  function renderLineAudit() {
    const a = stats.value?.audit_14days;
    if (!a) return;
    mountChart(lineAuditRef.value, {
      ...baseOpts(),
      tooltip: { ...baseOpts().tooltip, trigger: 'axis' },
      legend: { top: 0, textStyle: { color: TEXT_DIM }, icon: 'roundRect' },
      grid: { left: 30, right: 20, top: 40, bottom: 30, containLabel: true },
      xAxis: {
        type: 'category', data: a.days.map(shortDay), boundaryGap: false,
        axisLabel: { color: TEXT_DIM, fontSize: 11 },
        axisLine: { lineStyle: { color: LINE } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: TEXT_DIM },
        splitLine: { lineStyle: { color: LINE } },
      },
      series: [
        mkLine('新建', a.create, '#3fb950'),
        mkLine('更新', a.update, '#d29922'),
        mkLine('删除', a.delete, '#f85149'),
      ],
    });
  }

  function mkLine(name: string, data: number[], color: string) {
    return {
      name,
      type: 'line' as const,
      data,
      smooth: true,
      symbol: 'circle',
      symbolSize: 6,
      lineStyle: { color, width: 2 },
      itemStyle: { color },
      areaStyle: {
        color: {
          type: 'linear' as const,
          x: 0, y: 0, x2: 0, y2: 1,
          colorStops: [
            { offset: 0, color: color + '55' },
            { offset: 1, color: color + '00' },
          ],
        },
      },
    };
  }

  // 年代 Top8。
  function renderBarEra() {
    const rows = stats.value?.by_era_stats_top || [];
    mountChart(barEraRef.value, {
      ...baseOpts(),
      tooltip: { ...baseOpts().tooltip, trigger: 'axis', axisPointer: { type: 'shadow' } },
      xAxis: {
        type: 'category', data: rows.map((r) => r.name),
        axisLabel: { color: TEXT_DIM, interval: 0, rotate: rows.length > 5 ? 20 : 0 },
        axisLine: { lineStyle: { color: LINE } },
      },
      yAxis: {
        type: 'value',
        axisLabel: { color: TEXT_DIM },
        splitLine: { lineStyle: { color: LINE } },
      },
      series: [
        {
          type: 'bar', barMaxWidth: 36,
          data: rows.map((r) => r.count),
          itemStyle: {
            color: {
              type: 'linear' as const, x: 0, y: 0, x2: 0, y2: 1,
              colorStops: [{ offset: 0, color: '#bc8cff' }, { offset: 1, color: '#58a6ff' }],
            },
            borderRadius: [4, 4, 0, 0],
          },
          label: { show: true, position: 'top', color: TEXT, fontSize: 11 },
        },
      ],
    });
  }

  // 普查来源饼图。
  function renderPieSearch() {
    const rows = (stats.value?.by_search_type || []).filter((r) => r.count > 0);
    mountChart(pieSearchRef.value, {
      ...baseOpts(),
      tooltip: { ...baseOpts().tooltip, trigger: 'item', formatter: '{b}<br/>{c} 条 ({d}%)' },
      legend: {
        orient: 'vertical', right: 10, top: 'middle',
        textStyle: { color: TEXT_DIM, fontSize: 12 },
        itemWidth: 10, itemHeight: 10,
      },
      series: [
        {
          type: 'pie', radius: ['35%', '65%'], center: ['35%', '50%'],
          avoidLabelOverlap: true, minAngle: 3,
          itemStyle: { borderColor: '#0d1117', borderWidth: 2 },
          label: { show: false },
          emphasis: { label: { show: true, formatter: '{b}\n{c}', fontSize: 13, color: TEXT } },
          data: rows.map((r) => ({ name: r.label, value: r.count })),
        },
      ],
    });
  }

  // ── 时间格式化 ────────────────────────────
  function shortDay(d: string): string {
    // '2026-04-20' → '04-20'。
    return d.length >= 10 ? d.slice(5) : d;
  }
  function fmtTs(ts: number): string {
    if (!ts) return '—';
    return new Date(ts * 1000).toLocaleString('zh-CN', { hour12: false });
  }
  function relativeTs(ts: number): string {
    if (!ts) return '';
    const now = Date.now() / 1000;
    const diff = now - ts;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} 小时前`;
    if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 天前`;
    return new Date(ts * 1000).toLocaleDateString('zh-CN');
  }
  function actionLabel(a: string): string {
    return { create: '新建', update: '更新', delete: '删除' }[a] || a;
  }
  function actionType(a: string): 'success' | 'warning' | 'danger' | 'info' {
    return ({ create: 'success', update: 'warning', delete: 'danger' } as const)[a] || 'info';
  }
  function goAudit(code: string) {
    router.push({ path: '/audit', query: code ? { code } : {} });
  }

  // ── resize observer ─────────────────────────
  let ro: ResizeObserver | null = null;
  function setupResize() {
    ro = new ResizeObserver(() => {
      for (const c of charts) c.resize();
    });
    const root = donutCatRef.value?.parentElement?.parentElement?.parentElement;
    if (root) ro.observe(root);
    window.addEventListener('resize', onWinResize);
  }
  function onWinResize() {
    for (const c of charts) c.resize();
  }

  onMounted(async () => {
    await reload();
    setupResize();
  });
  onBeforeUnmount(() => {
    ro?.disconnect();
    window.removeEventListener('resize', onWinResize);
    for (const c of charts) c.dispose();
    charts.length = 0;
  });

  return {
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
  };
}
