/**
 * Свои уведомления вместо библиотеки: sonner весил 66 КБ — почти столько же,
 * сколько всё приложение. Здесь очередь на три сообщения и таймер.
 */
import { useEffect, useState } from "react";

interface Item {
  id: number;
  text: string;
  kind: "ok" | "err";
}

let push: ((t: Item) => void) | null = null;
let seq = 0;

export function toast(text: string, kind: "ok" | "err" = "ok"): void {
  push?.({ id: ++seq, text, kind });
}

export function Toaster() {
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    push = (t) => setItems((prev) => [...prev.slice(-2), t]);
    return () => {
      push = null;
    };
  }, []);

  useEffect(() => {
    if (!items.length) return;
    const timer = setTimeout(() => setItems((prev) => prev.slice(1)), 2600);
    return () => clearTimeout(timer);
  }, [items]);

  if (!items.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}
