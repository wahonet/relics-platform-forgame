import { useEffect, useState } from "react";
import {
  fetchCatalog,
  applyDataset,
  listApplications,
  reviewApplication,
} from "../api/catalog";
import type { CatalogDataset, CatalogApplication } from "../types";

const ACCESS_META: Record<string, { label: string; cls: string; note: string }> = {
  open: { label: "完全开放", cls: "ac-open", note: "可直接调用 API / 下载" },
  apply: { label: "申请共享", cls: "ac-apply", note: "提交用途说明,审核后开放" },
  restricted: { label: "受限使用", cls: "ac-restricted", note: "仅限主管部门定向共享" },
};

const STATUS_META: Record<string, { label: string; cls: string }> = {
  pending: { label: "待审核", cls: "st-pending" },
  approved: { label: "已通过", cls: "st-approved" },
  rejected: { label: "已驳回", cls: "st-rejected" },
};

export default function CatalogPage() {
  const [datasets, setDatasets] = useState<CatalogDataset[]>([]);
  const [applications, setApplications] = useState<CatalogApplication[]>([]);
  const [applyFor, setApplyFor] = useState<CatalogDataset | null>(null);
  const [form, setForm] = useState({ applicant: "", org: "", purpose: "", contact: "" });
  const [submitting, setSubmitting] = useState(false);
  const [toast, setToast] = useState("");

  const load = () => {
    fetchCatalog().then(setDatasets).catch(() => undefined);
    listApplications().then(setApplications).catch(() => undefined);
  };

  useEffect(() => {
    document.title = "数据资源目录 — 济宁市文物保护利用平台";
    load();
  }, []);

  const flash = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(""), 2500);
  };

  const submit = async () => {
    if (!applyFor) return;
    if (!form.applicant.trim() || !form.org.trim() || !form.purpose.trim()) {
      flash("请填写申请人、单位和用途");
      return;
    }
    setSubmitting(true);
    try {
      await applyDataset({ dataset_id: applyFor.id, ...form });
      flash("申请已提交,等待审核");
      setApplyFor(null);
      setForm({ applicant: "", org: "", purpose: "", contact: "" });
      load();
    } catch {
      flash("提交失败,请重试");
    } finally {
      setSubmitting(false);
    }
  };

  const review = async (id: number, status: "approved" | "rejected") => {
    try {
      await reviewApplication(
        id,
        status,
        status === "approved" ? "同意按申请用途使用,请遵守数据安全协议。" : "用途说明不充分,请补充后重新申请。",
      );
      load();
    } catch {
      flash("操作失败");
    }
  };

  return (
    <div className="cat-page">
      <div className="cat-hdr">
        <h1>数据资源目录与开放共享</h1>
        <span className="cat-sub">
          {datasets.length} 个数据集 · 分级分类管理 · 依申请共享
        </span>
      </div>

      <div className="cat-grid">
        {datasets.map((d) => {
          const meta = ACCESS_META[d.access] || ACCESS_META.apply;
          return (
            <div key={d.id} className="cat-card">
              <div className="cat-card-top">
                <span className="cat-cat">{d.category}</span>
                <span className={"cat-access " + meta.cls}>{meta.label}</span>
              </div>
              <h3>{d.name}</h3>
              <p className="cat-desc">{d.desc}</p>
              {d.api ? (
                <div className="cat-fields">
                  <code>{d.api}</code>
                </div>
              ) : null}
              <div className="cat-meta">
                <span>规模 <b>{d.count.toLocaleString()} {d.unit}</b></span>
                <span>格式 <b>{d.format}</b></span>
                <span>更新 <b>{d.update_freq}</b></span>
              </div>
              <div className="cat-actions">
                <span className="cat-note">{meta.note}</span>
                {d.access === "open" ? (
                  <button
                    className="pp-btn sm"
                    onClick={() => flash(`开放接口: ${d.api || "/docs"} (无需申请)`)}
                  >
                    查看接口
                  </button>
                ) : d.access === "apply" ? (
                  <button className="pp-btn sm primary" onClick={() => setApplyFor(d)}>
                    申请使用
                  </button>
                ) : (
                  <button className="pp-btn sm" disabled>
                    定向共享
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div className="cat-apps">
        <h2>共享申请记录</h2>
        {applications.length === 0 ? (
          <div className="pp-empty">暂无申请。选择上方"申请共享"类数据集提交试试。</div>
        ) : (
          <table className="pr-table">
            <thead>
              <tr>
                <th>#</th>
                <th>数据集</th>
                <th>申请人 / 单位</th>
                <th>用途</th>
                <th>状态</th>
                <th>审核意见</th>
                <th>操作(演示)</th>
              </tr>
            </thead>
            <tbody>
              {applications.map((a) => {
                const st = STATUS_META[a.status] || STATUS_META.pending;
                return (
                  <tr key={a.id}>
                    <td>{a.id}</td>
                    <td>{a.dataset_name || a.dataset_id}</td>
                    <td>
                      {a.applicant}
                      <div className="pr-sub">{a.org}</div>
                    </td>
                    <td className="cat-purpose">{a.purpose}</td>
                    <td>
                      <span className={"cat-status " + st.cls}>{st.label}</span>
                    </td>
                    <td className="cat-purpose">{a.reply || "—"}</td>
                    <td>
                      {a.status === "pending" ? (
                        <>
                          <button className="pp-btn sm" onClick={() => review(a.id, "approved")}>
                            通过
                          </button>{" "}
                          <button
                            className="pp-btn sm danger"
                            onClick={() => review(a.id, "rejected")}
                          >
                            驳回
                          </button>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {applyFor ? (
        <div className="pr-mask" onClick={() => setApplyFor(null)}>
          <div className="cat-modal" onClick={(e) => e.stopPropagation()}>
            <h3>申请使用 — {applyFor.name}</h3>
            <input
              className="pp-input"
              placeholder="申请人姓名 *"
              value={form.applicant}
              onChange={(e) => setForm({ ...form, applicant: e.target.value })}
            />
            <input
              className="pp-input"
              placeholder="申请单位 *"
              value={form.org}
              onChange={(e) => setForm({ ...form, org: e.target.value })}
            />
            <input
              className="pp-input"
              placeholder="联系方式"
              value={form.contact}
              onChange={(e) => setForm({ ...form, contact: e.target.value })}
            />
            <textarea
              className="pp-input"
              rows={4}
              placeholder="使用用途与场景说明 *(例如:用于文旅小程序的文物点位展示)"
              value={form.purpose}
              onChange={(e) => setForm({ ...form, purpose: e.target.value })}
            />
            <div className="cat-modal-actions">
              <button className="pp-btn" onClick={() => setApplyFor(null)}>
                取消
              </button>
              <button className="pp-btn primary" disabled={submitting} onClick={submit}>
                {submitting ? "提交中..." : "提交申请"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {toast ? <div className="toast show">{toast}</div> : null}
    </div>
  );
}
