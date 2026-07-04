import { useEffect, useRef, useState } from "react";
import { useUIStore } from "../stores/uiStore";
import { usePlatformStore } from "../stores/platformStore";
import { useRelicsStore } from "../stores/relicsStore";
import { fetchChatModels, streamChat, type ChatModel } from "../api/chat";
import { renderChatMarkdown, escapeStreamPreview } from "../utils/markdown";
import type { ChatMessage } from "../types";
import { flyTo } from "../map/viewerRegistry";

interface ChatBubble {
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
}

function buildGreeting(cityName: string, total: number): string {
  const totalStr = total > 0 ? `**${total}处**` : "";
  return (
    `你好！我是${cityName || "本市"}文物数据 AI 助手，` +
    `我掌握着全市 ${totalStr} 不可移动文物的台账数据(含嘉祥县全量层档案与三维模型信息)。\n\n` +
    `试试问我：\n` +
    `- ${cityName || "本市"}有哪些全国重点文物保护单位？\n` +
    `- 嘉祥县有哪些文物保存状况较差需要重点巡查？\n` +
    `- 各县市区文物分布情况如何？\n` +
    `- 哪些文物有三维模型可以在线查看？\n\n` +
    `回答中带 📍 的链接可直接在地图上定位查看！`
  );
}

export function ChatPanel() {
  const open = useUIStore((s) => s.chatPanelOpen);
  const setUI = useUIStore((s) => s.set);
  const config = usePlatformStore((s) => s.config);
  const allRelics = useRelicsStore((s) => s.all);

  const [messages, setMessages] = useState<ChatBubble[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [models, setModels] = useState<ChatModel[]>([]);
  const [model, setModel] = useState<string>("");
  const messagesRef = useRef<HTMLDivElement>(null);
  const greeted = useRef(false);

  useEffect(() => {
    fetchChatModels()
      .then((d) => {
        setModels(d.models || []);
        if (d.default) setModel(d.default);
      })
      .catch(() => {
        /* ignore */
      });
  }, []);

  useEffect(() => {
    if (open && !greeted.current) {
      const county = config?.administrative?.county_name || "本市";
      const total = config?.stats?.relics_total ?? allRelics.length;
      setMessages([{ role: "assistant", content: buildGreeting(county, total) }]);
      greeted.current = true;
    }
  }, [open, config, allRelics.length]);

  useEffect(() => {
    if (messagesRef.current) {
      messagesRef.current.scrollTop = messagesRef.current.scrollHeight;
    }
  }, [messages]);

  const onAction = (actionStr: string) => {
    if (actionStr.startsWith("fly:")) {
      const code = actionStr.slice(4);
      const r = useRelicsStore.getState().byCode.get(code);
      if (r?.center_lng && r.center_lat) {
        flyTo(r.center_lng, r.center_lat, 600);
        setUI({ selectedRelic: r });
      }
    }
  };

  const onMessageClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    const link = target.closest<HTMLAnchorElement>("a[data-action]");
    if (link) {
      const action = link.dataset.action;
      if (action) onAction(action);
    }
  };

  const send = async () => {
    if (streaming) return;
    const msg = input.trim();
    if (!msg) return;
    setInput("");
    const newMessages: ChatBubble[] = [
      ...messages,
      { role: "user", content: msg },
      { role: "assistant", content: "", streaming: true },
    ];
    setMessages(newMessages);
    setStreaming(true);
    let fullText = "";
    const history: ChatMessage[] = newMessages
      .filter((m) => !m.streaming)
      .map((m) => ({ role: m.role, content: m.content }));
    try {
      await streamChat(msg, history.slice(0, -1), model || undefined, {
        onChunk: (chunk) => {
          fullText += chunk;
          setMessages((curr) => {
            const next = [...curr];
            const last = next[next.length - 1];
            if (last && last.streaming) {
              next[next.length - 1] = { ...last, content: fullText };
            }
            return next;
          });
        },
        onError: (err) => {
          fullText += `\n[错误] ${err}`;
        },
      });
    } catch {
      fullText = "网络请求失败，请检查后端服务是否正常运行。";
    }
    setMessages((curr) => {
      const next = [...curr];
      const last = next[next.length - 1];
      if (last && last.streaming) {
        next[next.length - 1] = { ...last, content: fullText, streaming: false };
      }
      return next;
    });
    setStreaming(false);
  };

  const clear = () => {
    const county = config?.administrative?.county_name || "本市";
    const total = config?.stats?.relics_total ?? allRelics.length;
    setMessages([{ role: "assistant", content: buildGreeting(county, total) }]);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  if (!config?.features?.ai_chat) return null;

  return (
    <div className={"chat-panel" + (open ? " open" : "")}>
      <div className="chat-hdr">
        <h3>AI 知识库问答</h3>
        {models.length > 0 && (
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        )}
        <button onClick={clear}>清空</button>
        <button onClick={() => setUI({ chatPanelOpen: false })}>×</button>
      </div>
      <div className="chat-messages" ref={messagesRef} onClick={onMessageClick}>
        {messages.map((m, i) => (
          <div key={i} className={"cm cm-" + (m.role === "user" ? "user" : "ai")}>
            <div
              className="cm-bubble"
              dangerouslySetInnerHTML={{
                __html: m.streaming
                  ? escapeStreamPreview(m.content || "正在查询文物数据库...") +
                    '<span class="cm-cursor"></span>'
                  : renderChatMarkdown(m.content),
              }}
            />
          </div>
        ))}
      </div>
      <div className="chat-input">
        <textarea
          value={input}
          placeholder="按 Enter 发送，Shift+Enter 换行..."
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={streaming}
        />
        <button onClick={send} disabled={streaming || !input.trim()}>
          {streaming ? "..." : "发送"}
        </button>
      </div>
    </div>
  );
}
