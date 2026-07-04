import { usePlatformStore } from "../stores/platformStore";
import { useUIStore } from "../stores/uiStore";

export function Header() {
  const config = usePlatformStore((s) => s.config);
  const setUI = useUIStore((s) => s.set);
  const total = config?.stats?.relics_total ?? 0;
  const has3d = config?.stats?.has_3d_count ?? 0;
  const has3dEnabled = config?.features?.models_3d ?? false;
  const aiEnabled = config?.features?.ai_chat ?? false;
  const adminUrl = config?.admin_ui?.available ? config.admin_ui.url : "";

  const goAdmin = () => {
    if (!adminUrl) return;
    // 后台是另一套独立的 Vue SPA,在新标签打开,保持当前主前端会话不动。
    // 服务端的 AuthMiddleware 会自动处理鉴权:未登录 → /login?next=/admin-ui/ →
    // /app/#/login?next=/admin-ui/ → 登录成功后 LoginPage 回跳到 /admin-ui/。
    window.open(adminUrl, "_blank", "noopener,noreferrer");
  };

  return (
    <div className="header">
      <h1>{config?.project?.full_name || "不可移动文物数字档案平台"}</h1>
      <div className="hdr-right">
        <span className="badge">
          数据来源: <b>{config?.project?.data_source || "—"}</b>
        </span>
        <span className="badge">
          文物总数: <b>{total}</b>
          {has3dEnabled ? (
            <>
              {" "}
              · 三维: <b style={{ color: "#ffd700" }}>{has3d}</b>
            </>
          ) : null}
        </span>
        {aiEnabled ? (
          <button
            className="tb"
            onClick={() =>
              setUI({ chatPanelOpen: !useUIStore.getState().chatPanelOpen })
            }
          >
            <svg viewBox="0 0 24 24">
              <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z" />
            </svg>
            AI 助手
          </button>
        ) : null}
        {adminUrl ? (
          <button
            className="tb"
            onClick={goAdmin}
            title="打开数据管理后台 (新标签)"
          >
            <svg viewBox="0 0 24 24">
              <path d="M3 5h8v6H3V5zm10 0h8v3h-8V5zm0 5h8v9h-8v-9zM3 13h8v6H3v-6z" />
            </svg>
            后台管理
          </button>
        ) : null}
        <button
          className="tb"
          onClick={() => setUI({ settingsPanelOpen: true })}
          title="设置"
        >
          <svg viewBox="0 0 24 24">
            <path d="M19.14 12.94a7.36 7.36 0 0 0 .05-.94 7.36 7.36 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.04 7.04 0 0 0-1.62-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54a7 7 0 0 0-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.69 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.36 7.36 0 0 0-.05.94c0 .32.02.63.05.94L2.81 14.5a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .61.22l2.39-.96c.5.39 1.04.7 1.62.94l.36 2.54c.05.24.25.42.5.42h3.84c.25 0 .45-.18.5-.42l.36-2.54a7 7 0 0 0 1.62-.94l2.39.96a.5.5 0 0 0 .61-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" />
          </svg>
        </button>
      </div>
    </div>
  );
}
