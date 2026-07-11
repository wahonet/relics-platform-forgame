import { useEffect } from "react";
import { useTimelineStore } from "../stores/timelineStore";
import { ERA_ORDER } from "../utils/dict";

const STEP_MS = 1800;

/**
 * 地图底部的年代时间轴("文脉演变"演示模式)。
 * 点年代节点 = 显示该年代及更早的文物;播放按钮自动逐档推进,到"现代"停止。
 */
export function EraTimeline() {
  const active = useTimelineStore((s) => s.active);
  const index = useTimelineStore((s) => s.index);
  const playing = useTimelineStore((s) => s.playing);
  const setIndex = useTimelineStore((s) => s.setIndex);
  const setPlaying = useTimelineStore((s) => s.setPlaying);
  const close = useTimelineStore((s) => s.close);

  useEffect(() => {
    if (!active || !playing) return;
    const timer = window.setInterval(() => {
      const cur = useTimelineStore.getState().index;
      if (cur >= ERA_ORDER.length - 1) {
        setPlaying(false);
        return;
      }
      setIndex(cur + 1);
    }, STEP_MS);
    return () => window.clearInterval(timer);
  }, [active, playing, setIndex, setPlaying]);

  if (!active) return null;

  const togglePlay = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    // 已停在末档时从头播
    if (index >= ERA_ORDER.length - 1) setIndex(0);
    setPlaying(true);
  };

  return (
    <div className="era-timeline" role="group" aria-label="年代时间轴">
      <button
        type="button"
        className="era-play"
        onClick={togglePlay}
        title={playing ? "暂停" : "播放文脉演变"}
        aria-label={playing ? "暂停" : "播放"}
      >
        {playing ? (
          <svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z" /></svg>
        ) : (
          <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z" /></svg>
        )}
      </button>
      <div className="era-track">
        {ERA_ORDER.map((era, i) => (
          <button
            key={era}
            type="button"
            className={
              "era-node" + (i < index ? " lit" : "") + (i === index ? " cur" : "")
            }
            aria-pressed={i === index}
            onClick={() => {
              setPlaying(false);
              setIndex(i);
            }}
          >
            <i aria-hidden="true" />
            <span>{era}</span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="era-close"
        onClick={close}
        title="关闭时间轴"
        aria-label="关闭时间轴"
      >
        ×
      </button>
    </div>
  );
}
