import { useState } from "react";
import { login } from "../api/platform";

export default function LoginPage() {
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
        <h2>不可移动文物数字档案平台</h2>
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
