import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { selectColumns, type BoardState, type Card, type Member } from '@board/shared';
import { api, type Session } from '../api';
import type { BoardClient, BoardViewModel } from '../lib/boardClient';
import { cardMoveTarget, columnMoveTarget, type Direction } from '../lib/moves';
import { cardMatches, parseQuery } from '../lib/search';
import { navigate } from '../router';
import { ActivityPanel } from './ActivityPanel';
import { CardModal } from './CardModal';
import { MOVE_HELP_ID } from './CardTile';
import { Column } from './Column';
import { ShareDialog } from './ShareDialog';
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
  const [sharing, setSharing] = useState(false);
  const [showActivity, setShowActivity] = useState(false);
  const [query, setQuery] = useState('');
  const [renamingBoard, setRenamingBoard] = useState(false);
  const [boardName, setBoardName] = useState('');
  const readOnly = vm.role === 'viewer';
  const [memberList, setMemberList] = useState<Member[]>([]);
  const boardId = state.board.id;
  const members = useMemo(() => new Map(memberList.map((m) => [m.userId, m])), [memberList]);
  const lastTried = useRef('');
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [draggingColumnId, setDraggingColumnId] = useState<string | null>(null);
  const [columnDropIndex, setColumnDropIndex] = useState<number | null>(null);
  const [addingColumn, setAddingColumn] = useState(false);
  const [columnName, setColumnName] = useState('');
  // Keyboard moves are announced to screen readers, and focus is put back on whatever was moved.
  const [announcement, setAnnouncement] = useState('');
  // Selectors to try, in order, once the move has been drawn.
  const [refocus, setRefocus] = useState<string[] | null>(null);

  function moveCardBy(cardId: string, dir: Direction) {
    const target = cardMoveTarget(state, cardId, dir);
    if (!target) return;
    if (!client.moveCard(cardId, target.columnId, target.index)) return; // refused: the client has said why
    setAnnouncement(target.message);
    setRefocus([`[data-card-id="${cardId}"]`]);
  }

  function moveColumnBy(columnId: string, dir: 'left' | 'right') {
    const target = columnMoveTarget(state, columnId, dir);
    if (!target) return;
    if (!client.moveColumn(columnId, target.index)) return;
    setAnnouncement(target.message);
    // Moving an element in the DOM drops its focus; the button may also have just become disabled (end of the row).
    const button = (d: string) => `[data-column-id="${columnId}"] [data-move-col="${d}"]:not(:disabled)`;
    setRefocus([button(dir), button(dir === 'left' ? 'right' : 'left')]);
  }

  useEffect(() => {
    if (!refocus) return;
    for (const selector of refocus) {
      const el = document.querySelector<HTMLElement>(selector);
      if (el) {
        el.focus();
        break;
      }
    }
    setRefocus(null);
  }, [refocus, state]);

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
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if ((e.target as HTMLElement).closest?.('.search')) return; // Escape there only clears the search
      setOpenCardId(null);
      setSharing(false);
      setShowActivity(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const loadMembers = useCallback(async () => {
    try {
      setMemberList((await api.listMembers(boardId)).members);
    } catch {
      // Names and avatars are cosmetic; the board works without them.
    }
  }, [boardId]);

  // Reload when our own role changes, the Share dialog closes, or a card opens (the assignee picker must be current):
  // any of them may follow a change to who is on the board.
  useEffect(() => {
    void loadMembers();
  }, [loadMembers, vm.role, sharing, openCardId]);

  // A card can be assigned to someone who joined after we last looked; fetch once per unknown set.
  const unknownAssignees = Object.values(state.cards)
    .flatMap((c) => c.assigneeIds)
    .filter((id) => !members.has(id))
    .sort()
    .join(',');
  useEffect(() => {
    if (!unknownAssignees || unknownAssignees === lastTried.current) return;
    lastTried.current = unknownAssignees;
    void loadMembers();
  }, [unknownAssignees, loadMembers]);

  const columns = selectColumns(state);
  const words = parseQuery(query);
  const memberNames = useMemo(() => new Map(memberList.map((m) => [m.userId, m.name])), [memberList]);
  const filter = words.length > 0 ? (card: Card) => cardMatches(state, card, words, memberNames) : null;
  const matchCount = filter ? Object.values(state.cards).filter(filter).length : 0;

  /** Index among the other columns where a column dropped at `clientX` would land. */
  function columnIndexAt(clientX: number): number {
    const lanes = [...(lanesRef.current?.querySelectorAll<HTMLElement>('[data-column-id]') ?? [])].filter(
      (el) => el.dataset.columnId !== draggingColumnId,
    );
    const i = lanes.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return clientX < r.left + r.width / 2;
    });
    return i === -1 ? lanes.length : i;
  }
  const finishColumnDrag = () => {
    setDraggingColumnId(null);
    setColumnDropIndex(null);
  };
  const otherColumns = columns.filter((c) => c.id !== draggingColumnId);
  const openCard = openCardId ? state.cards[openCardId] : undefined;
  const editorsByCard = new Map<string, { name: string; color: string }[]>();
  for (const m of vm.presence) {
    if (m.socketId === vm.selfSocketId || !m.editingCardId) continue;
    editorsByCard.set(m.editingCardId, [...(editorsByCard.get(m.editingCardId) ?? []), m.user]);
  }

  return (
    <div className="page board-page">
      <header className="topbar">
        <button type="button" className="btn ghost back" onClick={() => navigate('/')} aria-label="Back to boards">
          Boards
        </button>
        <h1 className="board-title" data-testid="board-title">
          {renamingBoard ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                client.renameBoard(boardName);
                setRenamingBoard(false);
              }}
            >
              <input
                autoFocus
                aria-label="Board name"
                className="board-title-input"
                value={boardName}
                maxLength={80}
                onChange={(e) => setBoardName(e.target.value)}
                onBlur={() => setRenamingBoard(false)}
                onKeyDown={(e) => e.key === 'Escape' && setRenamingBoard(false)}
              />
            </form>
          ) : vm.role === 'owner' ? (
            <button
              type="button"
              className="title-btn"
              title="Click to rename"
              onClick={() => {
                setBoardName(state.board.name);
                setRenamingBoard(true);
              }}
            >
              {state.board.name}
            </button>
          ) : (
            state.board.name
          )}
        </h1>
        <span className="spacer" />
        <div className="search">
          <input
            type="search"
            aria-label="Search cards"
            placeholder="Search cards…"
            value={query}
            maxLength={100}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setQuery('');
              }
            }}
          />
          {filter && (
            <span className="search-count" role="status" data-testid="search-count">
              {matchCount} match{matchCount === 1 ? '' : 'es'}
            </span>
          )}
        </div>
        <button
          type="button"
          className="btn"
          data-testid="activity-toggle"
          aria-pressed={showActivity}
          onClick={() => setShowActivity((v) => !v)}
        >
          Activity
        </button>
        {vm.role && (
          <button type="button" className="btn" data-testid="share" onClick={() => setSharing(true)}>
            Share
          </button>
        )}
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
              : `Reconnecting…${vm.queued > 0 ? ` ${vm.queued} ${vm.queued === 1 ? 'change' : 'changes'} waiting` : ''}`}
        </span>
      </header>

      <p id={MOVE_HELP_ID} className="sr-only">
        Press Alt with the arrow keys to move this card. Enter opens it.
      </p>
      <p className="sr-only" role="status" aria-live="polite" data-testid="move-announcement">
        {announcement}
      </p>
      <main className="canvas" onPointerMove={onPointerMove}>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse drag-and-drop of columns; keyboard and touch reordering is tracked in TASKS.md (Phase 4) */}
        <div
          className="lanes"
          ref={lanesRef}
          data-testid="lanes"
          onDragOver={(e) => {
            if (!draggingColumnId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            setColumnDropIndex(columnIndexAt(e.clientX));
          }}
          onDrop={(e) => {
            if (!draggingColumnId) return;
            e.preventDefault();
            client.moveColumn(draggingColumnId, columnIndexAt(e.clientX));
            finishColumnDrag();
          }}
        >
          {columns.map((col) => (
            <Column
              key={col.id}
              column={col}
              state={state}
              client={client}
              draggingId={draggingId}
              setDraggingId={setDraggingId}
              editorsByCard={editorsByCard}
              members={members}
              filter={filter}
              onOpenCard={setOpenCardId}
              onMoveCard={moveCardBy}
              onMoveColumn={moveColumnBy}
              readOnly={readOnly}
              setDraggingColumnId={(id) => (id ? setDraggingColumnId(id) : finishColumnDrag())}
              dropMarker={
                draggingColumnId === null || columnDropIndex === null
                  ? null
                  : otherColumns[columnDropIndex]?.id === col.id
                    ? 'before'
                    : columnDropIndex >= otherColumns.length && otherColumns.at(-1)?.id === col.id
                      ? 'after'
                      : null
              }
            />
          ))}

          {!readOnly && (
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
                    <button type="submit" className="btn primary">
                      Add column
                    </button>
                    <button type="button" className="btn ghost" onClick={() => setAddingColumn(false)}>
                      Cancel
                    </button>
                  </div>
                </form>
              ) : (
                <button type="button" className="btn ghost add-column" onClick={() => setAddingColumn(true)}>
                  + Add column
                </button>
              )}
            </div>
          )}

          <Cursors cursors={vm.cursors} members={vm.presence} />
        </div>
      </main>

      {showActivity && <ActivityPanel boardId={boardId} seq={state.seq} onClose={() => setShowActivity(false)} />}
      {openCard && (
        <CardModal
          key={openCard.id}
          card={openCard}
          state={state}
          client={client}
          editors={editorsByCard.get(openCard.id) ?? []}
          members={memberList}
          readOnly={readOnly}
          selfUserId={session.user.id}
          isOwner={vm.role === 'owner'}
          onClose={() => setOpenCardId(null)}
        />
      )}
      {sharing && vm.role && (
        <ShareDialog
          boardId={state.board.id}
          role={vm.role}
          selfUserId={session.user.id}
          onClose={() => setSharing(false)}
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
