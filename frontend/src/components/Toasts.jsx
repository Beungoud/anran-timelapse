import React, { useCallback, useState } from "react";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

const ICONS = { ok: CheckCircle2, error: AlertTriangle, info: Info };

export function useToasts() {
  const [items, setItems] = useState([]);
  const dismiss = useCallback((id) => setItems((list) => list.filter((t) => t.id !== id)), []);
  const push = useCallback(
    (toast) => {
      const id = Math.random().toString(36).slice(2);
      setItems((list) => [...list.slice(-3), { ...toast, id }]);
      setTimeout(() => dismiss(id), toast.type === "error" ? 9000 : 4500);
    },
    [dismiss],
  );
  return { items, push, dismiss };
}

export function Toasts({ items, dismiss }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => {
        const Icon = ICONS[t.type] || Info;
        return (
          <div key={t.id} className={`toast ${t.type}`}>
            <Icon size={18} />
            <span>{t.text}</span>
            <button className="icon-btn small" onClick={() => dismiss(t.id)} aria-label="Fermer">
              <X size={14} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
