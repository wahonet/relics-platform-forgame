import { useDrillStore } from "../stores/drillStore";

/**
 * 地图左上角的下钻层级面包屑(全市 › 县 › 镇 › 村)。
 * 点击任意层级回到该级;仅在进入下钻状态后出现。
 */
export function DrillBreadcrumb() {
  const county = useDrillStore((s) => s.county);
  const township = useDrillStore((s) => s.township);
  const village = useDrillStore((s) => s.village);
  const drillTo = useDrillStore((s) => s.drillTo);
  const reset = useDrillStore((s) => s.reset);

  if (!county) return null;

  return (
    <div className="drill-bar" role="navigation" aria-label="行政区下钻层级">
      <button type="button" onClick={() => reset()}>全市</button>
      <span aria-hidden="true">›</span>
      <button
        type="button"
        className={!township ? "cur" : ""}
        onClick={() => drillTo({ county })}
      >
        {county}
      </button>
      {township ? (
        <>
          <span aria-hidden="true">›</span>
          <button
            type="button"
            className={!village ? "cur" : ""}
            onClick={() => drillTo({ county, township })}
          >
            {township}
          </button>
        </>
      ) : null}
      {village ? (
        <>
          <span aria-hidden="true">›</span>
          <button type="button" className="cur">{village}</button>
        </>
      ) : null}
      <button
        type="button"
        className="drill-exit"
        title="退出下钻(回到全市)"
        aria-label="退出下钻"
        onClick={() => reset()}
      >
        ×
      </button>
    </div>
  );
}
