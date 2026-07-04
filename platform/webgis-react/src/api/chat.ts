import { apiClient } from "./client";

export interface ChatModel {
  id: string;
  name: string;
}

export interface ChatModelsResp {
  models: ChatModel[];
  default?: string;
}

export async function fetchChatModels(): Promise<ChatModelsResp> {
  const { data } = await apiClient.get<ChatModelsResp>("/api/chat/models");
  return data;
}

export interface ChatStreamHandlers {
  onChunk: (text: string) => void;
  onError?: (msg: string) => void;
  onDone?: () => void;
  signal?: AbortSignal;
}

export async function streamChat(
  message: string,
  history: { role: "user" | "assistant"; content: string }[],
  model: string | undefined,
  handlers: ChatStreamHandlers,
) {
  const resp = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ message, history: history.slice(-10), model }),
    signal: handlers.signal,
  });

  if (!resp.body) {
    handlers.onError?.("无返回流");
    return;
  }
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() || "";
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const payload = line.slice(6);
      if (payload === "[DONE]") {
        handlers.onDone?.();
        continue;
      }
      try {
        const data = JSON.parse(payload);
        if (data.error) handlers.onError?.(data.error);
        else if (data.content) handlers.onChunk(data.content);
      } catch {
        /* ignore */
      }
    }
  }
  handlers.onDone?.();
}
