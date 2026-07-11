/**
 * 文物语音讲解。
 *
 * 首选后端 AI 情感语音(SiliconFlow CosyVoice2,支持中/英解说词);
 * 后端不可用时中文回退浏览器 Web Speech API,英文直接报不可用。
 */
import { apiClient } from "../api/client";
import { useUIStore } from "../stores/uiStore";
import type { RelicSummary } from "../types";

export type NarrationLang = "zh" | "en";
export type NarrationPhase = "idle" | "loading" | "playing";

/** 当前语音偏好(音色/语速/朗读范围,来自系统管理 → 设置)。 */
function ttsPrefs(lang: NarrationLang) {
  const s = useUIStore.getState();
  return {
    voice: lang === "zh" ? s.ttsVoiceZh : s.ttsVoiceEn,
    speed: s.ttsSpeed,
    scope: s.ttsScope,
  };
}

/** 结构化字段拼成一段自然的导览词(浏览器 TTS 回退用,与后端模板一致)。 */
export function buildNarration(r: RelicSummary, intro: string): string {
  const parts: string[] = [];
  const location = [r.county, r.township].filter(Boolean).join("");
  parts.push(`${r.name}${location ? `，位于${location}` : ""}。`);

  const facts: string[] = [];
  if (r.heritage_level && r.heritage_level.length < 20) facts.push(`是${r.heritage_level}`);
  if (r.era) facts.push(`年代为${r.era}`);
  if (r.category_main) facts.push(`属${r.category_main}类`);
  if (facts.length) parts.push(`${facts.join("，")}。`);

  if (r.condition_level) parts.push(`目前保存状况${r.condition_level}。`);

  const text = (intro || "").trim();
  parts.push(text || "暂无详细简介。");
  return parts.join("");
}

// ── AI 音频(带前端 blob 缓存) ──────────────────────────────
const audioUrlCache = new Map<string, string>();
const AUDIO_CACHE_MAX = 20;

async function fetchNarrationUrl(code: string, lang: NarrationLang): Promise<string> {
  const prefs = ttsPrefs(lang);
  const key = `${code}:${lang}:${prefs.voice}:${prefs.speed}:${prefs.scope}`;
  const cached = audioUrlCache.get(key);
  if (cached) return cached;
  const { data } = await apiClient.post<Blob>(
    "/api/tts/narrate",
    { code, lang, ...prefs },
    { responseType: "blob", timeout: 90_000 },
  );
  const url = URL.createObjectURL(data);
  audioUrlCache.set(key, url);
  if (audioUrlCache.size > AUDIO_CACHE_MAX) {
    const oldest = audioUrlCache.keys().next().value as string;
    URL.revokeObjectURL(audioUrlCache.get(oldest) || "");
    audioUrlCache.delete(oldest);
  }
  return url;
}

// ── 播放控制(同一时刻只有一个讲解在播) ─────────────────────
let currentAudio: HTMLAudioElement | null = null;
let currentUtterance: SpeechSynthesisUtterance | null = null;
let sessionSeq = 0;

function ttsSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

export function stopNarration(): void {
  sessionSeq += 1;
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = "";
    currentAudio = null;
  }
  if (ttsSupported()) {
    currentUtterance = null;
    window.speechSynthesis.cancel();
  }
}

function speakFallback(text: string, onDone: () => void): boolean {
  if (!ttsSupported()) return false;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "zh-CN";
  utterance.rate = 1;
  const voice = window.speechSynthesis
    .getVoices()
    .find((v) => v.lang?.toLowerCase().startsWith("zh"));
  if (voice) utterance.voice = voice;
  const finish = () => {
    if (currentUtterance === utterance) currentUtterance = null;
    onDone();
  };
  utterance.onend = finish;
  utterance.onerror = finish;
  currentUtterance = utterance;
  window.speechSynthesis.speak(utterance);
  return true;
}

export interface NarrationCallbacks {
  onPhase: (phase: NarrationPhase) => void;
  /** 讲解不可用时的用户提示(如英文未配置 AI 服务)。 */
  onNotice?: (text: string) => void;
}

/**
 * 播放某文物的讲解。返回的函数用于中途停止。
 * AI 音频失败时:中文回退浏览器 TTS,英文提示不可用。
 */
export function playNarration(
  relic: RelicSummary,
  intro: string,
  lang: NarrationLang,
  callbacks: NarrationCallbacks,
): void {
  stopNarration();
  const session = ++sessionSeq;
  const alive = () => session === sessionSeq;
  callbacks.onPhase("loading");

  const finish = () => {
    if (alive()) callbacks.onPhase("idle");
  };

  fetchNarrationUrl(relic.archive_code, lang)
    .then((url) => {
      if (!alive()) return;
      const audio = new Audio(url);
      currentAudio = audio;
      audio.onended = () => {
        if (currentAudio === audio) currentAudio = null;
        finish();
      };
      audio.onerror = () => {
        if (currentAudio === audio) currentAudio = null;
        finish();
      };
      audio
        .play()
        .then(() => {
          if (alive()) callbacks.onPhase("playing");
          else audio.pause();
        })
        .catch(finish);
    })
    .catch(() => {
      if (!alive()) return;
      // AI 语音不可用:中文回退浏览器本地朗读
      if (lang === "zh" && speakFallback(buildNarration(relic, intro), finish)) {
        callbacks.onNotice?.("AI 语音暂不可用，已切换本地朗读");
        callbacks.onPhase("playing");
        return;
      }
      callbacks.onNotice?.(
        lang === "en" ? "英文讲解需要配置 AI 服务后使用" : "语音讲解暂不可用",
      );
      finish();
    });
}
