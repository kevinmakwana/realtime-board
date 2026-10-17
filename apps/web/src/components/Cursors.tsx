import type { PresenceMember } from '@board/shared';
import type { RemoteCursor } from '../lib/boardClient';

export function Cursors({ cursors, members }: { cursors: RemoteCursor[]; members: PresenceMember[] }) {
  const bySocket = new Map(members.map((m) => [m.socketId, m.user]));
  return (
    <div className="cursors" aria-hidden>
      {cursors.map((c) => {
        const user = bySocket.get(c.socketId);
        if (!user) return null;
        return (
          <div
            key={c.socketId}
            className="cursor"
            data-testid="remote-cursor"
            data-name={user.name}
            style={{ left: `${c.x * 100}%`, top: `${c.y * 100}%`, '--c': user.color } as React.CSSProperties}
          >
            <svg width="18" height="22" viewBox="0 0 18 22">
              <path
                d="M1 1l0 17 4.5-4.2 3.2 7.2 3-1.4-3.2-7 6-.4z"
                fill="var(--c)"
                stroke="#fff"
                strokeWidth="1.5"
                strokeLinejoin="round"
              />
            </svg>
            <span className="flag">{user.name}</span>
          </div>
        );
      })}
    </div>
  );
}
