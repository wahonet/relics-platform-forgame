import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { apiClient } from "../api/client";

interface CardData {
  code: string;
  name: string;
  era: string;
  category_main: string;
  heritage_level: string;
  county: string;
  township: string;
  address: string;
  condition_level: string;
  intro: string;
  photos: string[];
}

type VoiceState = "idle" | "loading" | "playing";

/**
 * 文物数字名片(扫码分享的移动端页面,免登录)。
 * 首图 + 基础信息 + 简介 + 中英语音讲解。
 */
export default function CardPage() {
  const { code = "" } = useParams();
  const [card, setCard] = useState<CardData | null>(null);
  const [error, setError] = useState("");
  const [photoIndex, setPhotoIndex] = useState(0);
  const [voice, setVoice] = useState<{ lang: "zh" | "en"; state: VoiceState } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    document.title = "文物名片";
    apiClient
      .get<CardData>(`/api/card/${encodeURIComponent(code)}`)
      .then(({ data }) => {
        setCard(data);
        document.title = `${data.name} · 文物名片`;
      })
      .catch(() => setError("名片加载失败，请扫码重试"));
    return () => {
      audioRef.current?.pause();
      audioRef.current = null;
    };
  }, [code]);

  const stopVoice = () => {
    audioRef.current?.pause();
    audioRef.current = null;
    setVoice(null);
  };

  const playVoice = async (lang: "zh" | "en") => {
    if (voice?.lang === lang && voice.state !== "idle") {
      stopVoice();
      return;
    }
    stopVoice();
    setVoice({ lang, state: "loading" });
    try {
      const { data } = await apiClient.post<Blob>(
        "/api/tts/narrate",
        { code, lang },
        { responseType: "blob", timeout: 90_000 },
      );
      const audio = new Audio(URL.createObjectURL(data));
      audioRef.current = audio;
      audio.onended = () => {
        if (audioRef.current === audio) setVoice(null);
      };
      await audio.play();
      setVoice({ lang, state: "playing" });
    } catch {
      setVoice(null);
      alert("语音讲解暂不可用");
    }
  };

  if (error) {
    return <div className="card-page"><div className="card-error">{error}</div></div>;
  }
  if (!card) {
    return <div className="card-page"><div className="card-error">加载中…</div></div>;
  }

  const location = [card.county, card.township].filter(Boolean).join(" · ");

  return (
    <div className="card-page">
      <div className="card-sheet">
        {card.photos.length > 0 ? (
          <div className="card-photo">
            <img src={card.photos[photoIndex]} alt={card.name} />
            {card.photos.length > 1 ? (
              <div className="card-photo-dots">
                {card.photos.map((_, i) => (
                  <button
                    key={i}
                    type="button"
                    className={i === photoIndex ? "on" : ""}
                    aria-label={`第 ${i + 1} 张照片`}
                    onClick={() => setPhotoIndex(i)}
                  />
                ))}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="card-photo card-photo-empty">暂无照片</div>
        )}

        <div className="card-body">
          <h1>{card.name}</h1>
          <div className="card-tags">
            {card.heritage_level && card.heritage_level.length < 20 ? (
              <span className="lv">{card.heritage_level}</span>
            ) : null}
            {card.era ? <span>{card.era}</span> : null}
            {card.category_main ? <span>{card.category_main}</span> : null}
            {card.condition_level ? <span>保存{card.condition_level}</span> : null}
          </div>
          {location ? <div className="card-loc">{location}</div> : null}
          {card.address ? <div className="card-addr">{card.address}</div> : null}

          <div className="card-voice">
            {(["zh", "en"] as const).map((lang) => {
              const active = voice?.lang === lang;
              const label = lang === "zh" ? "中文讲解" : "English";
              return (
                <button
                  key={lang}
                  type="button"
                  className={active ? "on" : ""}
                  onClick={() => void playVoice(lang)}
                >
                  {active && voice?.state === "loading"
                    ? "生成中…"
                    : active
                    ? "■ 停止"
                    : `▶ ${label}`}
                </button>
              );
            })}
          </div>

          <div className="card-intro">
            {(card.intro || "暂无简介。").split(/\n+/).map((para, i) => (
              <p key={i}>{para}</p>
            ))}
          </div>
        </div>

        <div className="card-foot">济宁市文物保护利用平台 · 文物数字名片</div>
      </div>
    </div>
  );
}
