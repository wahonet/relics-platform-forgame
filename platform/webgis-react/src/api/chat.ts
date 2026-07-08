export interface ChatStreamHandlers {
  onChunk: (text: string) => void;
  onError?: (msg: string) => void;
  onDone?: () => void;
  signal?: AbortSignal;
}

// 模型由系统管理页统一配置,前端不再传模型参数
export async function streamChat(
  message: string,
  history: { role: "user" | "assistant"; content: string }[],
  handlers: ChatStreamHandlers,
) {
  const resp = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ message, history: history.slice(-10) }),
    signal: handlers.signal,
  });

  // fetch 不走 axios 拦截器,401 要在这里自行跳登录。
  if (resp.status === 401) {
    handlers.onError?.("登录已过期，请重新登录");
    if (!location.hash.includes("login")) location.hash = "/login";
    return;
  }
  if (!resp.ok) {
    let detail = "";
    try {
      detail = (await resp.json())?.detail || "";
    } catch {
      /* 响应体不是 JSON,忽略 */
    }
    handlers.onError?.(detail || `服务返回 ${resp.status}`);
    return;
  }
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
