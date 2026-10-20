import { useEffect, useState } from 'react';
import type { ActivityEntry } from '@board/shared';
import { api } from '../api';

interface Props {
  boardId: string;
  /** The board's latest sequence number; the feed reloads when it moves. */
  seq: number;
  onClose: () => void;
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();

function when(ts: string): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return sameDay(d, new Date()) ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
}

export function ActivityPanel({ boardId, seq, onClose }: Props) {
  const [entries, setEntries] = useState<ActivityEntry[] | null>(null);
  const [error, setError] = useState('');

  // Reload shortly after the board changes, so a burst of edits is one request.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const r = await api.activity(boardId);
        if (!cancelled) {
          setEntries(r.entries);
          setError('');
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not load activity');
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [boardId, seq]);

  return (
    <aside className="activity" aria-label="Activity">
      <header className="modal-head">
        <h2>Activity</h2>
        <button type="button" className="icon-btn" aria-label="Close activity" onClick={onClose}>
          ×
        </button>
      </header>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {entries === null && !error && <p className="note">Loading…</p>}
      {entries?.length === 0 && <p className="note">Nothing has happened on this board yet.</p>}
      <ol className="activity-list" data-testid="activity">
        {entries?.map((e) => (
          <li key={e.seq} data-testid="activity-item">
            <span>
              <strong>{e.actorName}</strong> {e.text}
            </span>
            <time dateTime={e.ts}>{when(e.ts)}</time>
          </li>
        ))}
      </ol>
    </aside>
  );
}
