import { useEffect, useState } from "react";
import { login } from "../api/platform";
import { usePlatformStore } from "../stores/platformStore";

export default function LoginPage() {
  const config = usePlatformStore((s) => s.config);
  const loadPlatform = usePlatformStore((s) => s.load);
  useEffect(() => {
    loadPlatform();
  }, [loadPlatform]);
  const title = config?.project?.full_name || "济宁市文物保护利用平台";

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      await login(username, password);
      // 支持 ?next=/admin-ui/ 这类回跳:hash 路由形式 #/login?next=...
      // 同时兼容 query string 形式 ?next=...
      const hash = location.hash || "";
      const qIdx = hash.indexOf("?");
      const hashQS = qIdx >= 0 ? hash.slice(qIdx + 1) : "";
      const qs = new URLSearchParams(hashQS || location.search.replace(/^\?/, ""));
      const next = qs.get("next") || "";
      if (next && /^\/[a-zA-Z0-9/_\-?&=#%.]*$/.test(next)) {
        // 跳出 SPA hash 路由,直接 navigate 到后台等绝对路径
        location.href = next;
      } else {
        location.hash = "/";
        location.reload();
      }
    } catch (err) {
      const msg =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (err as any)?.response?.data?.detail || "登录失败,请检查用户名或密码";
      setError(msg);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="login-emblem" aria-hidden>
          <svg viewBox="0 0 24 24">
            <path d="M12 2 3 7v2h18V7l-9-5zm-7 9v7H3v2h18v-2h-2v-7h-2v7h-3v-7h-2v7H9v-7H5z" />
          </svg>
        </div>
        <h2>{title}</h2>
        <p>请使用管理员账号登录</p>
        {error ? <div className="login-error">{error}</div> : null}
        <input
          type="text"
          placeholder="用户名"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
        />
        <input
          type="password"
          placeholder="密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <button type="submit" disabled={submitting || !username || !password}>
          {submitting ? "登录中..." : "登录"}
        </button>
      </form>
    </div>
  );
}
