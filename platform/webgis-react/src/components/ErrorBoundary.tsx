import React from "react";

interface Props {
  /** 该 Boundary 内出错时显示的简短 fallback 文案,默认显示错误信息。 */
  label?: string;
  /** 该 Boundary 包裹的子节点。 */
  children: React.ReactNode;
}

interface State {
  err: Error | null;
}

/**
 * 局部错误边界。包裹任意一个面板,使该面板内部渲染异常不会把整个 React 树清空,
 * 避免单个组件的 bug 把整页变成黑屏。
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { err: null };

  static getDerivedStateFromError(err: Error): State {
    return { err };
  }

  componentDidCatch(err: Error, info: React.ErrorInfo): void {
    console.error(`[${this.props.label || "ErrorBoundary"}]`, err, info.componentStack);
  }

  render() {
    if (this.state.err) {
      return (
        <div
          style={{
            position: "absolute",
            top: 64,
            right: 16,
            padding: "10px 14px",
            background: "rgba(248, 81, 73, 0.12)",
            border: "1px solid rgba(248, 81, 73, 0.45)",
            borderRadius: 8,
            color: "#f85149",
            fontSize: 12,
            maxWidth: 420,
            zIndex: 9000,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {this.props.label || "组件"} 渲染出错
          </div>
          <div style={{ color: "#c9d1d9", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {String(this.state.err.message || this.state.err)}
          </div>
          <button
            onClick={() => this.setState({ err: null })}
            style={{
              marginTop: 8,
              background: "rgba(255,255,255,.08)",
              border: "1px solid rgba(255,255,255,.18)",
              color: "#c9d1d9",
              borderRadius: 4,
              padding: "3px 10px",
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            重试
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
