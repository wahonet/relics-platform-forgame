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
        <div className="err-boundary">
          <div className="err-boundary-title">
            {this.props.label || "组件"} 渲染出错
          </div>
          <div className="err-boundary-msg">
            {String(this.state.err.message || this.state.err)}
          </div>
          <button onClick={() => this.setState({ err: null })}>重试</button>
        </div>
      );
    }
    return this.props.children;
  }
}
