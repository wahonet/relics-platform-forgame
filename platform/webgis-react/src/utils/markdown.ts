/**
 * 轻量 Markdown 渲染 (port of chat.js renderMd).
 * 额外把 [[label|action]] 渲染为可触发地图联动的链接。
 */

function escapeHtml(t: string): string {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderChatMarkdown(text: string): string {
  let h = escapeHtml(text);

  h = h.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, (_, label, action) => {
    const a = String(action).replace(/&amp;/g, "&").replace(/'/g, "\\'");
    const isLog = a.startsWith("log:");
    const icon = isLog ? " 📋" : " 📍";
    const tip = isLog ? "查看工作日志" : "在地图上查看";
    const cls = isLog ? "cf cf-log" : "cf";
    return `<a class="${cls}" data-action="${a}" title="${tip}">${label}${icon}</a>`;
  });

  h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");
  h = h.replace(/^####\s+(.+)$/gm, "<h5>$1</h5>");
  h = h.replace(/^###\s+(.+)$/gm, "<h4>$1</h4>");
  h = h.replace(/^##\s+(.+)$/gm, "<h4>$1</h4>");
  h = h.replace(/^#\s+(.+)$/gm, "<h4>$1</h4>");
  h = h.replace(/^---+$/gm, "<hr>");
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");

  const lines = h.split("\n");
  const out: string[] = [];
  let inList = false;
  let listType: "ul" | "ol" = "ul";
  for (const li of lines) {
    const ulMatch = li.match(/^[-·•]\s+(.+)/);
    const olMatch = li.match(/^(\d+)[.\u3001]\s*(.+)/);
    if (ulMatch) {
      if (!inList || listType !== "ul") {
        if (inList) out.push(`</${listType}>`);
        out.push("<ul>");
        inList = true;
        listType = "ul";
      }
      out.push("<li>" + ulMatch[1] + "</li>");
    } else if (olMatch) {
      if (!inList || listType !== "ol") {
        if (inList) out.push(`</${listType}>`);
        out.push("<ol>");
        inList = true;
        listType = "ol";
      }
      out.push("<li>" + olMatch[2] + "</li>");
    } else {
      if (inList) {
        out.push(`</${listType}>`);
        inList = false;
      }
      out.push(li);
    }
  }
  if (inList) out.push(`</${listType}>`);

  let body = out.join("\n").replace(/\n/g, "<br>");
  body = body.replace(/<br>(<\/?(?:ul|ol|li|h[345]|hr))/g, "$1");
  body = body.replace(/(<\/(?:ul|ol|li|h[345]|hr)>)<br>/g, "$1");
  body = body.replace(/(<(?:ul|ol|hr)[^>]*>)<br>/g, "$1");
  return body;
}

export function escapeStreamPreview(text: string): string {
  return escapeHtml(text).replace(/\n/g, "<br>");
}
