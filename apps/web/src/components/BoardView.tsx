import { useCallback, useEffect, useRef, useState } from 'react';
import { selectColumns, type BoardState } from '@board/shared';
import type { Session } from '../api';
import type { BoardClient, BoardViewModel } from '../lib/boardClient';
import { navigate } from '../router';
import { CardModal } from './CardModal';
import { Column } from './Column';
import { Cursors } from './Cursors';
import { PresenceBar } from './PresenceBar';
import { Toasts } from './Toasts';

interface Props {
  client: BoardClient;
  vm: BoardViewModel;
  state: BoardState;
  session: Session;
}

export function BoardView({ client, vm, state, session }: Props) {
  const lanesRef = useRef<HTMLDivElement>(null);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const [columnName, setColumnName] = useState('');

  // Cursor position is normalised to the lanes element so it lines up across different window sizes.
  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const rect = lanesRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) return;
      client.sendCursor((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
    },
    [client],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpenCardId(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const columns = selectColumns(state);
  const openCard = openCardId ? state.cards[openCardId] : undefined;
  const editorsByCard = new Map<string, { name: string; color: string }[]>();
  for (const m of vm.presence) {
    if (m.socketId === vm.selfSocketId || !m.editingCardId) continue;
    editorsByCard.set(m.editingCardId, [...(editorsByCard.get(m.editingCardId) ?? []), m.user]);
  }

  return (
    <div className="page board-page">
      <header className="topbar">
        <button className="btn ghost back" onClick={() => navigate('/')} aria-label="Back to boards">
          Boards
        </button>
        <h1 className="board-title">{state.board.name}</h1>
        <span className="spacer" />
        <PresenceBar members={vm.presence} selfUserId={session.user.id} />
        <span
          className={`conn ${vm.status}`}
          role="status"
          data-testid="connection"
          title={vm.instance ? `Connected to ${vm.instance}` : undefined}
        >
          <span className="dot" />
          {vm.status === 'live'
            ? `Live on ${vm.instance}`
            : vm.status === 'unauthorized'
              ? 'Signed out'
              : 'Reconnecting…'}
        </span>
      </header>

      <main className="canvas" onPointerMove={onPointerMove}>
        <div className="lanes" ref={lanesRef} data-testid="lanes">
          {columns.map((col) => (
            <Column
              key={col.id}
              column={col}
              state={state}
              client={client}
              draggingId={draggingId}
              setDraggingId={setDraggingId}
              editorsByCard={editorsByCard}
              onOpenCard={setOpenCardId}
            />
          ))}

          <div className="lane add-lane">
            {addingColumn ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  client.createColumn(columnName);
                  setColumnName('');
                  setAddingColumn(false);
                }}
              >
                <input
                  autoFocus
                  aria-label="Column name"
                  placeholder="Column name"
                  maxLength={60}
                  value={columnName}
                  onChange={(e) => setColumnName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && setAddingColumn(false)}
                />
                <div className="row">
                  <button className="btn primary">Add column</button>
                  <button type="button" className="btn ghost" onClick={() => setAddingColumn(false)}>
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button className="btn ghost add-column" onClick={() => setAddingColumn(true)}>
                + Add column
              </button>
            )}
          </div>

          <Cursors cursors={vm.cursors} members={vm.presence} />
        </div>
      </main>

      {openCard && (
        <CardModal
          key={openCard.id}
          card={openCard}
          state={state}
          client={client}
          editors={editorsByCard.get(openCard.id) ?? []}
          onClose={() => setOpenCardId(null)}
        />
      )}
      {openCardId && !openCard && <GoneNotice onDone={() => setOpenCardId(null)} />}
      <Toasts client={client} />
    </div>
  );
}

/** The card an open modal pointed at was deleted by someone else. */
function GoneNotice({ onDone }: { onDone: () => void }) {
  useEffect(() => onDone(), [onDone]);
  return null;
}
