import { useEffect, useState } from 'react';
import type { BoardClient, Notice } from '../lib/boardClient';

export function Toasts({ client }: { client: BoardClient }) {
  const [toasts, setToasts] = useState<(Notice & { id: number })[]>([]);

  useEffect(() => {
    let n = 0;
    return client.onNotice((notice) => {
      const id = ++n;
      setToasts((t) => [...t.slice(-2), { ...notice, id }]);
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
    });
  }, [client]);

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <p key={t.id} className={`toast ${t.kind}`} data-testid="toast">
          {t.message}
        </p>
      ))}
    </div>
  );
}
