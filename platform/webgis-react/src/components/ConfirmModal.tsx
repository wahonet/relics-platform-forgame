import { useEffect, useState } from "react";

interface ConfirmOptions {
  title: string;
  body?: string;
  /** danger 时标题圆点与确认按钮变红 */
  danger?: boolean;
  okText?: string;
  cancelText?: string;
}

type Resolver = (ok: boolean) => void;

let hostSetter: ((s: { opts: ConfirmOptions; resolve: Resolver } | null) => void) | null = null;

/** 主题化确认弹窗,替代原生 window.confirm。需要 <ConfirmHost /> 已挂载。 */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  if (!hostSetter) return Promise.resolve(window.confirm(opts.body ? `${opts.title}\n${opts.body}` : opts.title));
  return new Promise<boolean>((resolve) => {
    hostSetter!({ opts, resolve });
  });
}

export function ConfirmHost() {
  const [req, setReq] = useState<{ opts: ConfirmOptions; resolve: Resolver } | null>(null);

  useEffect(() => {
    hostSetter = setReq;
    return () => {
      hostSetter = null;
    };
  }, []);

  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
      if (e.key === "Enter") close(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req]);

  if (!req) return null;
  const { opts, resolve } = req;

  const close = (ok: boolean) => {
    setReq(null);
    resolve(ok);
  };

  return (
    <div className="cfm-mask" onMouseDown={(e) => e.target === e.currentTarget && close(false)}>
      <div className={"cfm-modal" + (opts.danger ? " danger" : "")}>
        <h3>{opts.title}</h3>
        {opts.body ? <div className="cfm-body">{opts.body}</div> : null}
        <div className="cfm-actions">
          <button className="pp-btn" onClick={() => close(false)}>
            {opts.cancelText || "取消"}
          </button>
          <button className={"pp-btn " + (opts.danger ? "danger" : "primary")} onClick={() => close(true)}>
            {opts.okText || "确定"}
          </button>
        </div>
      </div>
    </div>
  );
}
