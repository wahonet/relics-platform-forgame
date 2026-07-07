import { useEffect, useRef, useState } from "react";
import { useUIStore } from "../stores/uiStore";
import { usePlatformStore } from "../stores/platformStore";
import { useRelicsStore } from "../stores/relicsStore";
import { useFilterStore } from "../stores/filterStore";
import { streamChat } from "../api/chat";
import { fetchRelicDetail } from "../api/relics";
import { renderChatMarkdown, escapeStreamPreview } from "../utils/markdown";
import { categoryCode, rankCode, RANK_MAP } from "../utils/dict";
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
  const messagesRef = useRef<HTMLDivElement>(null);
  const greeted = useRef(false);

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

  /** 级别短语("省级"/"全国重点"等) → FilterPanel 的级别显示值。 */
  const levelLabel = (v: string): string => {
    const code = rankCode(v);
    return code === "5" ? "未核定" : (RANK_MAP[code]?.label || v);
  };

  const onAction = async (actionStr: string) => {
    // fly:编号 → 定位并打开详情
    if (actionStr.startsWith("fly:")) {
      const code = actionStr.slice(4).trim();
      let r = useRelicsStore.getState().byCode.get(code);
      if (!r) {
        try {
          r = await fetchRelicDetail(code);
        } catch {
          useUIStore.getState().showToast(`未找到编号 ${code} 的文物`);
          return;
        }
      }
      if (r?.center_lng != null && r.center_lat != null) {
        flyTo(r.center_lng, r.center_lat, 600);
        setUI({ selectedRelic: r });
      }
      return;
    }

    // 筛选参数(& 连接): cty:县区 t:乡镇 l:级别 c:类别 s:现状 3d:1 kw:关键词
    const fs = useFilterStore.getState();
    const all = useRelicsStore.getState().all;
    const counties = new Set(all.map((x) => x.county).filter(Boolean) as string[]);
    const patch: Record<string, string> = {};
    let catNames: Set<string> | null = null;
    let applied = false;
    for (const part of actionStr.split("&")) {
      const i = part.indexOf(":");
      if (i <= 0) continue;
      const key = part.slice(0, i).trim();
      const val = part.slice(i + 1).trim();
      if (!val) continue;
      applied = true;
      switch (key) {
        case "cty":
          patch.county = val;
          break;
        case "t":
          // 模型偶尔把县区当乡镇输出,按实际县区名单纠正
          if (counties.has(val)) patch.county = val;
          else patch.township = val;
          break;
        case "l":
          patch.level = levelLabel(val);
          break;
        case "s":
          patch.cond = val;
          break;
        case "3d":
          patch.threeD = val === "1" ? "1" : "0";
          break;
        case "kw":
          patch.search = val;
          break;
        case "c": {
          const code = categoryCode(val);
          catNames = new Set(
            all.map((x) => x.category_main)
              .filter((n): n is string => !!n && categoryCode(n) === code),
          );
          break;
        }
        default:
          applied = false;
      }
    }
    if (!applied && !catNames) return;
    fs.setPartial(patch as Parameters<typeof fs.setPartial>[0]);
    if (catNames?.size) fs.setActiveCats(catNames);
    setUI({ filterPanelOpen: true });
    useUIStore.getState().showToast("已按 AI 回答内容筛选地图点位");
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
      await streamChat(msg, history.slice(0, -1), {
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
