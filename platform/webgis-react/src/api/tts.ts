import { apiClient } from "./client";

export interface TtsConfig {
  ready: boolean;
  tts_model: string;
  translate_model: string;
  voices: string[];
}

export async function fetchTtsConfig(): Promise<TtsConfig> {
  const { data } = await apiClient.get<TtsConfig>("/api/tts/config");
  return data;
}

/** 固定文本试听(设置页选音色/语速用)。 */
export async function previewTts(body: {
  lang: "zh" | "en";
  voice: string;
  speed: number;
}): Promise<Blob> {
  const { data } = await apiClient.post<Blob>("/api/tts/preview", body, {
    responseType: "blob",
    timeout: 60_000,
  });
  return data;
}
