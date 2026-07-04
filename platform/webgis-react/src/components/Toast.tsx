import { useUIStore } from "../stores/uiStore";

export function Toast() {
  const toast = useUIStore((s) => s.toast);
  if (!toast) return null;
  return <div className="toast">{toast.text}</div>;
}
