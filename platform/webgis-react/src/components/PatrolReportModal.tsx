import { useEffect, useState } from "react";
import { fetchReport, assessRecord } from "../api/patrol";
import type { PatrolReport } from "../types";
import { useUIStore } from "../stores/uiStore";

/**
 * 巡查报告弹窗:
 * - 汇总(到点率/核验率/里程) + 每站明细(打卡照片、GPS 核验、AI 评估)
 * - 对已有照片的记录可触发 AI 视觉评估(与库内基准照对比,判断保存状况)
 * - 可选生成 AI 文字总结
 */
export function PatrolReportModal({
  routeId,
  onClose,
}: {
  routeId: number;
  onClose: () => void;
}) {
  const showToast = useUIStore((s) => s.showToast);
  const [report, setReport] = useState<PatrolReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const [assessing, setAssessing] = useState<number | null>(null);

  const load = (withAI = false) => {
    (withAI ? setAiLoading : setLoading)(true);
    fetchReport(routeId, withAI)
      .then(setReport)
      .catch(() => showToast("报告加载失败"))
      .finally(() => (withAI ? setAiLoading : setLoading)(false));
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId]);

  const doAssess = async (recordId: number) => {
    setAssessing(recordId);
    try {
      const resp = await assessRecord(recordId);
      if (resp.ok && resp.assessment) {
        showToast(`AI 评估:${resp.assessment.condition || "完成"}`);
        load();
      } else {
        showToast(resp.detail || "AI 评估不可用(未配置视觉模型 Key)");
      }
    } catch (e) {
      const msg =
        (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail ||
        "AI 评估失败";
      showToast(msg);
    } finally {
      setAssessing(null);
    }
  };

  return (
    <div className="pr-mask" onClick={onClose}>
      <div className="pr-modal" onClick={(e) => e.stopPropagation()}>
        <div className="pr-hdr">
          <h3>巡查报告{report ? ` — ${report.summary.route_name}` : ""}</h3>
          <button className="pp-btn sm" disabled={aiLoading} onClick={() => load(true)}>
            {aiLoading ? "生成中..." : "AI 文字总结"}
          </button>
          <button className="pp-btn sm" onClick={() => window.print()}>
            打印
          </button>
          <button className="pi-close" onClick={onClose}>
            ×
          </button>
        </div>

        {loading || !report ? (
          <div className="pp-empty" style={{ padding: 40 }}>
            {loading ? "正在生成报告..." : "暂无数据"}
          </div>
        ) : (
          <div className="pr-body">
            <div className="pr-cards">
              <div className="pr-card">
                <b>{report.summary.stop_count}</b>
                <span>计划点位</span>
              </div>
              <div className="pr-card">
                <b>{report.summary.checked_count}</b>
                <span>已打卡</span>
              </div>
              <div className="pr-card ok">
                <b>{report.summary.verified_count}</b>
                <span>GPS 核验通过</span>
              </div>
              <div className="pr-card">
                <b>{report.summary.verify_rate}%</b>
                <span>核验率</span>
              </div>
              <div className="pr-card">
                <b>{report.summary.distance_km}</b>
                <span>路线里程 (km)</span>
              </div>
            </div>

            {report.summary.condition_worse.length > 0 && (
              <div className="pr-warn">
                AI 比对发现疑似劣化: {report.summary.condition_worse.join("、")}
              </div>
            )}

            {report.prose ? <div className="pr-ai-report">{report.prose}</div> : null}

            <table className="pr-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>文物</th>
                  <th>县区/级别</th>
                  <th>台账现状</th>
                  <th>打卡</th>
                  <th>现场照片</th>
                  <th>AI 评估</th>
                </tr>
              </thead>
              <tbody>
                {report.items.map((it, i) => (
                  <tr key={it.code}>
                    <td>{i + 1}</td>
                    <td>
                      <div className="pr-name">{it.name}</div>
                      <div className="pr-sub">{it.address || it.township}</div>
                    </td>
                    <td>
                      <div>{it.county}</div>
                      <div className="pr-sub">{it.heritage_level}</div>
                    </td>
                    <td>
                      <span className={"cond-" + it.condition}>{it.condition || "—"}</span>
                    </td>
                    <td>
                      {it.verified ? (
                        <span className="pr-ok">已核验</span>
                      ) : it.checked ? (
                        <span className="pr-warn-t">
                          已打卡{it.distance_m != null ? ` (${Math.round(it.distance_m)}m)` : " (无定位)"}
                        </span>
                      ) : (
                        <span className="pr-miss">未到</span>
                      )}
                    </td>
                    <td>
                      {it.photo ? (
                        <a href={it.photo} target="_blank" rel="noreferrer">
                          <img className="pr-photo" src={it.photo} alt="" />
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td>
                      {it.ai_condition ? (
                        <>
                          <span className={"cond-" + it.ai_condition}>{it.ai_condition}</span>
                          <div className="pr-sub">{it.ai_summary}</div>
                        </>
                      ) : it.photo && it.record_id != null ? (
                        <button
                          className="pp-btn sm"
                          disabled={assessing != null}
                          onClick={() => doAssess(it.record_id!)}
                        >
                          {assessing === it.record_id ? "评估中..." : "AI 识别"}
                        </button>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
