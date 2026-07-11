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

const speechOK = typeof window !== "undefined" && "speechSynthesis" in window;

/** 中文导览词(与后端 _narration_zh 模板一致,本地回退朗读用)。 */
function narrationZh(c: CardData): string {
  const parts: string[] = [];
  const loc = [c.county, c.township].filter(Boolean).join("");
  parts.push(`${c.name}${loc ? `，位于${loc}` : ""}。`);
  const facts: string[] = [];
  if (c.heritage_level && c.heritage_level.length < 20) facts.push(`是${c.heritage_level}`);
  if (c.era) facts.push(`年代为${c.era}`);
  if (c.category_main) facts.push(`属${c.category_main}类`);
  if (facts.length) parts.push(`${facts.join("，")}。`);
  if (c.condition_level) parts.push(`目前保存状况${c.condition_level}。`);
  parts.push((c.intro || "").trim() || "暂无详细简介。");
  return parts.join("").slice(0, 600);
}

const LEVEL_EN: [string, string][] = [
  ["全国重点", "a National Key Cultural Relics Protection Site"],
  ["省", "a Provincial-level Protected Site"],
  ["市", "a Municipal-level Protected Site"],
  ["县", "a County-level Protected Site"],
];
const CATEGORY_EN: [string, string][] = [
  ["古建筑", "ancient architecture"],
  ["古墓葬", "ancient tombs"],
  ["古遗址", "ancient sites"],
  ["石窟寺", "grottoes and stone carvings"],
  ["近现代", "modern historic sites and representative buildings"],
];
const CONDITION_EN: [string, string][] = [
  ["较好", "fairly good"], ["较差", "poor"], ["好", "good"], ["一般", "fair"], ["差", "bad"],
];

function dictEn(value: string, dict: [string, string][]): string {
  for (const [k, v] of dict) if (value.includes(k)) return v;
  return "";
}

/**
 * 本地回退用的简版英文导览词(结构化字段静态翻译,专名保留中文原文)。
 * 简介正文无法本地翻译,末尾引导阅读下方文字。
 */
function narrationEnLocal(c: CardData): string {
  const parts: string[] = [c.name];
  const level = c.heritage_level ? dictEn(c.heritage_level, LEVEL_EN) : "";
  parts.push(` is ${level || "a cultural heritage site"}`);
  const cat = c.category_main ? dictEn(c.category_main, CATEGORY_EN) : "";
  if (cat) parts.push(` in the category of ${cat}`);
  const loc = [c.county, c.township].filter(Boolean).join(" ");
  if (loc) parts.push(`, located in ${loc}`);
  parts.push(". ");
  const cond = c.condition_level ? dictEn(c.condition_level, CONDITION_EN) : "";
  if (cond) parts.push(`Its current state of preservation is ${cond}. `);
  parts.push("For the full introduction, please read the text below.");
  return parts.join("");
}

/**
 * 中英混排文本按 CJK 连续段切分,分段指定发音语言逐句朗读,
 * 使英文讲解中的中文专名(文物名/地名)仍以中文发音读出。
 */
function speakSegments(text: string, mainLang: "zh" | "en", onDone: () => void): void {
  const segs =
    mainLang === "zh"
      ? [{ text, lang: "zh-CN" }]
      : (text.match(/[\u3400-\u9fff\u3000-\u303f]+|[^\u3400-\u9fff\u3000-\u303f]+/g) || [text]).map(
          (s) => ({ text: s, lang: /[\u3400-\u9fff]/.test(s) ? "zh-CN" : "en-US" }),
        );
  let remaining = 0;
  for (const seg of segs) {
    if (!seg.text.trim()) continue;
    remaining += 1;
    const u = new SpeechSynthesisUtterance(seg.text);
    u.lang = seg.lang;
    u.onend = u.onerror = () => {
      remaining -= 1;
      if (remaining <= 0) onDone();
    };
    window.speechSynthesis.speak(u);
  }
  if (remaining === 0) onDone();
}

/**
 * 文物数字名片(扫码分享的移动端页面,免登录)。
 * 首图 + 基础信息 + 简介 + 中英语音讲解。
 *
 * 播放策略(兼容手机浏览器的手势播放限制):
 * 1. 点击时同步把后端 GET 音频直链赋给 <audio> 并 play()(AI 情感语音);
 * 2. 后端不可用(未配 Key/无外网)时回退手机本地语音合成:
 *    中文读完整导览词,英文读结构化字段拼的简版解说(专名中文发音)。
 */
export default function CardPage() {
  const { code = "" } = useParams();
  const [card, setCard] = useState<CardData | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [photoIndex, setPhotoIndex] = useState(0);
  const [voice, setVoice] = useState<{ lang: "zh" | "en"; state: VoiceState } | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const seqRef = useRef(0);
  const cardRef = useRef<CardData | null>(null);

  useEffect(() => {
    document.title = "文物名片";
    apiClient
      .get<CardData>(`/api/card/${encodeURIComponent(code)}`)
      .then(({ data }) => {
        setCard(data);
        cardRef.current = data;
        document.title = `${data.name} · 文物名片`;
      })
      .catch(() => setError("名片加载失败，请扫码重试"));
    return () => stopVoice();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const stopVoice = () => {
    seqRef.current += 1;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = "";
      audioRef.current = null;
    }
    if (speechOK) window.speechSynthesis.cancel();
    setVoice(null);
  };

  /** AI 音频失败时回退手机本地语音合成。 */
  const fallbackLocal = (lang: "zh" | "en", session: number) => {
    if (seqRef.current !== session) return;
    const c = cardRef.current;
    if (!c || !speechOK) {
      setVoice(null);
      setNotice("AI 语音暂不可用，且当前浏览器不支持本地语音合成");
      return;
    }
    setNotice(
      lang === "zh"
        ? "AI 语音暂不可用，已切换手机本地朗读"
        : "AI 英文讲解暂不可用，已用手机本地语音朗读要点（详细简介请阅读下方文字）",
    );
    setVoice({ lang, state: "playing" });
    speakSegments(lang === "zh" ? narrationZh(c) : narrationEnLocal(c), lang, () => {
      if (seqRef.current === session) setVoice(null);
    });
  };

  const playVoice = (lang: "zh" | "en") => {
    if (voice?.lang === lang && voice.state !== "idle") {
      stopVoice();
      return;
    }
    stopVoice();
    setNotice("");
    const session = seqRef.current;
    setVoice({ lang, state: "loading" });

    // iOS 等平台要求 speechSynthesis 首次调用发生在用户手势内,先用空语句解锁
    if (speechOK) {
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(new SpeechSynthesisUtterance(""));
    }

    // 音频直链在手势内同步 play(),浏览器边下边播;后端 5xx 会触发 error 事件
    const audio = new Audio();
    audio.preload = "auto";
    audio.src = `/api/tts/narrate?code=${encodeURIComponent(code)}&lang=${lang}`;
    audioRef.current = audio;

    let settled = false;
    const fail = () => {
      if (settled || seqRef.current !== session) return;
      settled = true;
      if (audioRef.current === audio) audioRef.current = null;
      audio.pause();
      fallbackLocal(lang, session);
    };
    // 生成+传输超时兜底(移动网络下 AI 合成可能很慢)
    const timer = window.setTimeout(fail, 60_000);

    audio.onplaying = () => {
      if (seqRef.current !== session) return;
      settled = true;
      window.clearTimeout(timer);
      setVoice({ lang, state: "playing" });
    };
    audio.onended = () => {
      window.clearTimeout(timer);
      if (audioRef.current === audio) audioRef.current = null;
      if (seqRef.current === session) setVoice(null);
    };
    audio.onerror = () => {
      window.clearTimeout(timer);
      fail();
    };
    audio.play().catch(() => {
      window.clearTimeout(timer);
      fail();
    });
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
                  onClick={() => playVoice(lang)}
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
          {notice ? <div className="card-notice">{notice}</div> : null}

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
