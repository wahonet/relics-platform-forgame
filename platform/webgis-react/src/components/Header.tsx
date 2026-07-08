import { Link, useNavigate } from "react-router-dom";
import { usePlatformStore } from "../stores/platformStore";
import { useUIStore } from "../stores/uiStore";
import type { AppTab } from "../App";
import emblemUrl from "../assets/emblem-wenhua-jining.png";

const NAV_TABS: { tab: AppTab; label: string; to: string }[] = [
  { tab: "map", label: "地图总览", to: "/" },
  { tab: "dashboard", label: "资源概览", to: "/dashboard" },
  { tab: "parcels", label: "图斑对比", to: "/parcels" },
  { tab: "patrol", label: "文物巡查", to: "/patrol" },
  { tab: "admin", label: "系统管理", to: "/admin" },
];

export function Header({ activeTab }: { activeTab: AppTab }) {
  const config = usePlatformStore((s) => s.config);
  const setUI = useUIStore((s) => s.set);
  const navigate = useNavigate();
  const aiEnabled = config?.features?.ai_chat ?? false;
  const onMap = activeTab === "map";

  return (
    <div className="header">
      <span className="hdr-emblem" aria-hidden>
        <img src={emblemUrl} alt="" draggable={false} />
      </span>
      <h1>{config?.project?.full_name || "文物保护利用平台"}</h1>

      <nav className="hdr-nav">
        {NAV_TABS.map((n) => (
          <Link
            key={n.tab}
            className={"hdr-nav-item" + (activeTab === n.tab ? " on" : "")}
            to={n.to}
          >
            {n.label}
          </Link>
        ))}
      </nav>

      <div className="hdr-right">
        {aiEnabled ? (
          <button
            className="tb"
            onClick={() => {
              if (!onMap) navigate("/");
              setUI({ chatPanelOpen: !useUIStore.getState().chatPanelOpen });
            }}
          >
            <svg viewBox="0 0 24 24">
              <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-2 12H6v-2h12v2zm0-3H6V9h12v2zm0-3H6V6h12v2z" />
            </svg>
            AI 助手
          </button>
        ) : null}
        <button
          className="tb"
          onClick={() => {
            if (!onMap) navigate("/");
            setUI({ settingsPanelOpen: true });
          }}
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
