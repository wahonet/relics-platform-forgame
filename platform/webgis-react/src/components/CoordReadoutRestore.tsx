import { useUIStore } from "../stores/uiStore";

/** 坐标读数被关闭后,在右下角显示一个 "📐 坐标" 小按钮供恢复。 */
export function CoordReadoutRestore() {
  const visible = useUIStore((s) => s.coordReadoutVisible);
  const setUI = useUIStore((s) => s.set);

  if (visible) return null;
  return (
    <button
      className="coord-readout-restore"
      title="显示鼠标坐标读数"
      onClick={() => {
        localStorage.setItem("coordReadoutVisible", "1");
        setUI({ coordReadoutVisible: true });
      }}
    >
      📐 坐标
    </button>
  );
}
