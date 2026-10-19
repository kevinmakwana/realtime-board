import { useEffect, useState, useSyncExternalStore } from 'react';
import { io } from 'socket.io-client';
import { setSession, type Session } from '../api';
import { BoardClient, type BoardSocket } from '../lib/boardClient';
import { pinnedNode } from '../lib/node';
import { uuid } from '../lib/uuid';
import { navigate } from '../router';
import { BoardView } from './BoardView';

/** Owns the socket + sync engine for one board and tears them down on leave. */
export function BoardPage({ boardId, session }: { boardId: string; session: Session }) {
  const [client, setClient] = useState<BoardClient | null>(null);

  useEffect(() => {
    // `cid` is a per-tab id. The nginx load balancer hashes on it, so each tab sticks to one instance
    // while different tabs spread across instances (hashing on IP would pin every local tab together).
    // `node` optionally pins the tab to a specific instance (see lib/node.ts).
    const node = pinnedNode();
    const socket: BoardSocket = io({ auth: { token: session.token }, query: { cid: uuid(), ...(node && { node }) } });
    // Test hook: lets Playwright sever the transport to exercise reconnect + catch-up.
    if (import.meta.env.DEV) (window as unknown as { __boardSocket?: BoardSocket }).__boardSocket = socket;
    const c = new BoardClient(socket, boardId, session.user);
    setClient(c);
    return () => {
      c.dispose();
      setClient(null);
    };
  }, [boardId, session]);

  if (!client) return null;
  return <ConnectedBoard client={client} session={session} />;
}

function ConnectedBoard({ client, session }: { client: BoardClient; session: Session }) {
  const vm = useSyncExternalStore(client.subscribe, client.getSnapshot);

  useEffect(() => {
    if (vm.status === 'unauthorized') setSession(null);
  }, [vm.status]);

  if (vm.status === 'removed') {
    return (
      <div className="page center">
        <p role="status" data-testid="no-access">
          You no longer have access to this board.
        </p>
        <button type="button" className="btn primary" onClick={() => navigate('/')}>
          Back to boards
        </button>
      </div>
    );
  }

  if (!vm.state) {
    return (
      <div className="page center">
        <p role="status">{vm.status === 'reconnecting' ? 'Reconnecting…' : 'Opening board…'}</p>
        <button type="button" className="btn ghost" onClick={() => navigate('/')}>
          Back to boards
        </button>
      </div>
    );
  }
  return <BoardView client={client} vm={vm} state={vm.state} session={session} />;
}
