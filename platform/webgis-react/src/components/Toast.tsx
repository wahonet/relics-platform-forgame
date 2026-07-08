import { useUIStore } from "../stores/uiStore";

export function Toast() {
  const toast = useUIStore((s) => s.toast);
  if (!toast) return null;
  const kindClass = toast.kind !== "info" ? ` toast-${toast.kind}` : "";
  return <div className={`toast${kindClass}`}>{toast.text}</div>;
}
