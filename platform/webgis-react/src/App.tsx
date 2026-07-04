import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Header } from "./components/Header";
import { Toolbar } from "./components/Toolbar";
import { FilterPanel } from "./components/FilterPanel";
import { Dashboard } from "./components/Dashboard";
import { InfoPanel } from "./components/InfoPanel";
import { ChatPanel } from "./components/ChatPanel";
import { PatrolPanel } from "./components/PatrolPanel";
import { SettingsPanel } from "./components/SettingsPanel";
import { TileDownloadPanel } from "./components/TileDownloadPanel";
import { BoundaryDownloadPanel } from "./components/BoundaryDownloadPanel";
import { CoordReadout } from "./components/CoordReadout";
import { CoordReadoutRestore } from "./components/CoordReadoutRestore";
import { CrsInspectorPanel } from "./components/CrsInspectorPanel";
import { Toast } from "./components/Toast";
import { Compass } from "./components/Compass";
import { MapView } from "./map/MapView";
import { usePlatformStore } from "./stores/platformStore";
import { useRelicsStore } from "./stores/relicsStore";
import { useUIStore } from "./stores/uiStore";
import { ErrorBoundary } from "./components/ErrorBoundary";

function App() {
  const platformLoaded = usePlatformStore((s) => s.loaded);
  const platformLoad = usePlatformStore((s) => s.load);
  const relicsLoaded = useRelicsStore((s) => s.loaded);
  const relicsLoading = useRelicsStore((s) => s.loading);
  const relicsLoad = useRelicsStore((s) => s.load);
  const loadError = useRelicsStore((s) => s.loadError);
  const [searchParams, setSearchParams] = useSearchParams();

  const [compassRot, setCompassRot] = useState(0);
  const [scale, setScale] = useState("");

  useEffect(() => {
    if (!platformLoaded) platformLoad();
  }, [platformLoaded, platformLoad]);

  useEffect(() => {
    if (!relicsLoaded && !relicsLoading) relicsLoad();
  }, [relicsLoaded, relicsLoading, relicsLoad]);

  // 支持 /?patrol=1 直达巡查规划(门面大屏的入口链接)。
  useEffect(() => {
    if (searchParams.get("patrol") === "1") {
      useUIStore.getState().set({ patrolPanelOpen: true });
      setSearchParams({}, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const onCompassRotate = useCallback((deg: number) => setCompassRot(deg), []);
  const onScaleUpdate = useCallback((label: string) => setScale(label), []);

  return (
    <>
      <ErrorBoundary label="Header"><Header /></ErrorBoundary>
      <ErrorBoundary label="Toolbar"><Toolbar /></ErrorBoundary>
      <ErrorBoundary label="MapView">
        <MapView onCompassRotate={onCompassRotate} onScaleUpdate={onScaleUpdate} />
      </ErrorBoundary>
      <Compass rotation={compassRot} scale={scale} />

      <ErrorBoundary label="FilterPanel"><FilterPanel /></ErrorBoundary>
      <ErrorBoundary label="Dashboard"><Dashboard /></ErrorBoundary>
      <ErrorBoundary label="InfoPanel"><InfoPanel /></ErrorBoundary>
      <ErrorBoundary label="ChatPanel"><ChatPanel /></ErrorBoundary>
      <ErrorBoundary label="PatrolPanel"><PatrolPanel /></ErrorBoundary>
      <ErrorBoundary label="SettingsPanel"><SettingsPanel /></ErrorBoundary>
      <ErrorBoundary label="TileDownloadPanel"><TileDownloadPanel /></ErrorBoundary>
      <ErrorBoundary label="BoundaryDownloadPanel"><BoundaryDownloadPanel /></ErrorBoundary>
      <ErrorBoundary label="CoordReadout"><CoordReadout /></ErrorBoundary>
      <ErrorBoundary label="CoordReadoutRestore"><CoordReadoutRestore /></ErrorBoundary>
      <ErrorBoundary label="CrsInspectorPanel"><CrsInspectorPanel /></ErrorBoundary>

      {(!platformLoaded || (!relicsLoaded && relicsLoading)) && (
        <div className="center-loader">
          <div className="spinner" />
          {!platformLoaded ? "正在拉取平台配置..." : "正在加载文物数据..."}
        </div>
      )}
      {loadError ? (
        <div className="center-loader" style={{ color: "var(--red)" }}>
          数据加载失败: {loadError}
        </div>
      ) : null}
      <Toast />
    </>
  );
}

export default App;
