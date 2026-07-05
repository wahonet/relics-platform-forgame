import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  fetchPipelineStatus,
  fetchTask,
  fetchApiConfig,
  runPipeline,
  saveApiConfig,
  type AdminTask,
  type ApiConfigStatus,
  type PipelineStatus,
} from "../api/admin";

const STEP_DESC: Record<string, string> = {
  "01": "读取 data/input/01_relics 的台账 Excel/CSV,挂接照片与图纸",
  "02": "行政边界 Shapefile/GeoJSON 统一转为 WGS-84 GeoJSON",
  "03": "生成 relics.db(R-Tree 空间索引 + FTS5 全文搜索)",
};

export default function AdminPage() {
  const [pipeline, setPipeline] = useState<PipelineStatus | null>(null);
  const [task, setTask] = useState<AdminTask>({ status: "idle" });
  const [config, setConfig] = useState<ApiConfigStatus | null>(null);
  const [form, setForm] = useState({ sf: "", amap: "", ion: "" });
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState("");
  const logRef = useRef<HTMLPreElement>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const flash = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(""), 3000);
  };

  const refreshPipeline = useCallback(() => {
    fetchPipelineStatus().then(setPipeline).catch(() => undefined);
  }, []);

  const refreshConfig = useCallback(() => {
    fetchApiConfig().then(setConfig).catch(() => undefined);
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const startPolling = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const t = await fetchTask();
        setTask(t);
        if (t.status !== "running") {
          stopPolling();
          refreshPipeline();
        }
      } catch {
        /* ignore */
      }
    }, 1200);
  }, [stopPolling, refreshPipeline]);

  useEffect(() => {
    document.title = "系统管理 — 济宁市文物保护利用平台";
    refreshPipeline();
    refreshConfig();
    // 页面打开时若已有任务在跑,续上轮询
    fetchTask().then((t) => {
      setTask(t);
      if (t.status === "running") startPolling();
    }).catch(() => undefined);
    return stopPolling;
  }, [refreshPipeline, refreshConfig, startPolling, stopPolling]);

  // 日志自动滚到底
  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [task.log?.length]);

  const running = task.status === "running";

  const run = async (opts: { only?: string; demo?: boolean }) => {
    try {
      await runPipeline(opts);
      setTask({ status: "running", log: [] });
      startPolling();
    } catch (e) {
      const detail =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (e as any)?.response?.data?.detail || "启动任务失败";
      flash(detail);
    }
  };

  const save = async () => {
    if (!form.sf.trim() && !form.amap.trim() && !form.ion.trim()) {
      flash("请至少填写一项后再保存(留空表示不修改)");
      return;
    }
    setSaving(true);
    try {
      const res = await saveApiConfig({
        siliconflow_key: form.sf.trim() || undefined,
        amap_web_key: form.amap.trim() || undefined,
        cesium_ion_token: form.ion.trim() || undefined,
      });
      flash(res.message || "已保存");
      setForm({ sf: "", amap: "", ion: "" });
      refreshConfig();
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      flash((e as any)?.response?.data?.detail || "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const manifestOf = (stepId: string) =>
    pipeline?.last_manifest?.steps?.find((s) => s.id === stepId);

  return (
    <div className="adm-page">
      <div className="bs-hdr">
        <Link to="/" className="bs-back">← 返回地图</Link>
        <h1>系统管理</h1>
        <span className="bs-clock">数据管线 · API 配置</span>
      </div>

      {/* ── 数据管线 ─────────────────────────────── */}
      <div className="adm-sec">
        <div className="adm-sec-hdr">
          <h2>数据管线</h2>
          <div className="adm-actions">
            <button
              className="pp-btn sm"
              disabled={running}
              onClick={() => run({ demo: true })}
              title="没有真实数据时,先生成一批演示台账/照片/档案"
            >
              生成演示数据
            </button>
            <button
              className="pp-btn sm primary"
              disabled={running}
              onClick={() => run({})}
            >
              {running ? "运行中..." : "▶ 运行全部管线"}
            </button>
          </div>
        </div>

        <div className="adm-steps">
          {(pipeline?.steps || []).map((s) => {
            const m = manifestOf(s.id);
            const outputsOk = s.missing_outputs.length === 0 && s.outputs.length > 0;
            const inputsOk = s.missing_inputs.length === 0;
            return (
              <div key={s.id} className="adm-step">
                <div className="adm-step-top">
                  <span className={"adm-step-idx" + (outputsOk ? " ok" : "")}>{s.id}</span>
                  <div className="adm-step-name">
                    {s.name}
                    <em>{STEP_DESC[s.id] || s.script}{s.optional ? " · 可选" : ""}</em>
                  </div>
                  <button
                    className="pp-btn sm"
                    disabled={running}
                    onClick={() => run({ only: s.id })}
                  >
                    单步运行
                  </button>
                </div>
                <div className="adm-step-io">
                  {s.inputs.map((a) => (
                    <span key={"i" + a.label} className={"adm-io" + (a.exists ? " ok" : " miss")}>
                      入 {a.label}{a.kind === "dir" ? ` ×${a.count}` : ""}
                    </span>
                  ))}
                  {s.outputs.map((a) => (
                    <span key={"o" + a.label} className={"adm-io" + (a.exists ? " ok" : " miss")}>
                      出 {a.label}{a.kind === "dir" ? ` ×${a.count}` : ""}
                    </span>
                  ))}
                  {m ? (
                    <span className={"adm-io last-" + m.status}>
                      上次 {m.status === "done" ? `成功 ${m.duration_sec ?? "?"}s` : m.status}
                    </span>
                  ) : null}
                </div>
                {!inputsOk && !running ? (
                  <div className="adm-step-warn">
                    缺少输入:{s.missing_inputs.map((a) => `${a.label} (${a.path})`).join("、")}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>

        {task.status !== "idle" ? (
          <div className="adm-log-box">
            <div className="adm-log-hdr">
              <span className={"adm-task-st st-" + task.status}>
                {task.status === "running" ? "● 运行中" : task.status === "done" ? "✓ 完成" : "✗ 失败"}
              </span>
              <span className="adm-task-label">{task.label}</span>
              {task.status !== "running" && task.returncode != null ? (
                <span className="adm-task-rc">exit {task.returncode}</span>
              ) : null}
            </div>
            <pre ref={logRef} className="adm-log">{(task.log || []).join("\n")}</pre>
          </div>
        ) : (
          <div className="pp-empty">
            尚未运行任务。首次使用可先点「生成演示数据」,再「运行全部管线」建库。
          </div>
        )}
      </div>

      {/* ── API 配置 ─────────────────────────────── */}
      <div className="adm-sec">
        <div className="adm-sec-hdr">
          <h2>外部 API 配置</h2>
          <span className="adm-hint">
            保存写入 config.yaml,AI 与高德即时生效;留空的项不会被修改
          </span>
        </div>

        <div className="adm-keys">
          <div className="adm-key-row">
            <div className="adm-key-meta">
              <b>SiliconFlow Key</b>
              <em>AI 问答 / 巡查意图解析 / 照片评估 / 报告生成</em>
              <span className={"adm-key-st" + (config?.runtime.ai_ready ? " on" : "")}>
                {config?.runtime.ai_ready
                  ? `已启用 ${config?.siliconflow.masked}`
                  : config?.siliconflow.configured
                    ? `已配置 ${config?.siliconflow.masked}(客户端未就绪)`
                    : "未配置 · AI 降级为规则模式"}
              </span>
            </div>
            <input
              className="pp-input"
              type="password"
              placeholder="sk-... (留空不修改)"
              value={form.sf}
              onChange={(e) => setForm({ ...form, sf: e.target.value })}
            />
          </div>

          <div className="adm-key-row">
            <div className="adm-key-meta">
              <b>高德 Web 服务 Key</b>
              <em>巡查驾车路线规划;未配置时路线用直线连接</em>
              <span className={"adm-key-st" + (config?.runtime.amap_ready ? " on" : "")}>
                {config?.runtime.amap_ready
                  ? `已启用 ${config?.amap.masked}`
                  : "未配置"}
              </span>
            </div>
            <input
              className="pp-input"
              type="password"
              placeholder="高德开放平台 Web服务 key (留空不修改)"
              value={form.amap}
              onChange={(e) => setForm({ ...form, amap: e.target.value })}
            />
          </div>

          <div className="adm-key-row">
            <div className="adm-key-meta">
              <b>Cesium Ion Token</b>
              <em>在线高精度地形(可选);保存后需刷新页面生效</em>
              <span className={"adm-key-st" + (config?.cesium_ion.configured ? " on" : "")}>
                {config?.cesium_ion.configured ? `已配置 ${config?.cesium_ion.masked}` : "未配置"}
              </span>
            </div>
            <input
              className="pp-input"
              type="password"
              placeholder="Cesium Ion access token (留空不修改)"
              value={form.ion}
              onChange={(e) => setForm({ ...form, ion: e.target.value })}
            />
          </div>
        </div>

        <div className="adm-save-row">
          <span className="adm-hint">配置文件: {config?.config_path || "config.yaml"}</span>
          <button className="pp-btn primary" disabled={saving} onClick={save}>
            {saving ? "保存中..." : "保存配置"}
          </button>
        </div>
      </div>

      {toast ? <div className="toast">{toast}</div> : null}
    </div>
  );
}
