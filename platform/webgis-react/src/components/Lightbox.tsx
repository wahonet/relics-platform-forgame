import { useEffect } from "react";

interface LightboxProps {
  urls: string[];
  captions: string[];
  index: number;
  onChangeIndex: (i: number) => void;
  onClose: () => void;
}

export function Lightbox({ urls, captions, index, onChangeIndex, onClose }: LightboxProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft" && index > 0) onChangeIndex(index - 1);
      else if (e.key === "ArrowRight" && index < urls.length - 1) onChangeIndex(index + 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [index, urls.length, onChangeIndex, onClose]);

  if (!urls.length) return null;

  return (
    <div className="lightbox open" onClick={onClose}>
      <button className="lb-x" onClick={onClose}>×</button>
      {index > 0 && (
        <button
          className="lb-nav lb-prev"
          onClick={(e) => {
            e.stopPropagation();
            onChangeIndex(index - 1);
          }}
        >
          ‹
        </button>
      )}
      {index < urls.length - 1 && (
        <button
          className="lb-nav lb-next"
          onClick={(e) => {
            e.stopPropagation();
            onChangeIndex(index + 1);
          }}
        >
          ›
        </button>
      )}
      <img
        src={urls[index]}
        alt=""
        onClick={(e) => e.stopPropagation()}
        onError={(e) => {
          (e.currentTarget as HTMLImageElement).style.display = "none";
        }}
      />
      <div className="lb-cap">
        {captions[index] || ""} ({index + 1} / {urls.length})
      </div>
    </div>
  );
}
