import { useEffect, useRef, useState } from 'react';
import {
  selectCards,
  selectComments,
  type BoardState,
  type Card,
  type Column as ColumnModel,
  type Member,
} from '@board/shared';
import type { BoardClient } from '../lib/boardClient';
import { columnMoveTarget, type Direction } from '../lib/moves';
import { CardTile } from './CardTile';

interface Props {
  column: ColumnModel;
  state: BoardState;
  client: BoardClient;
  draggingId: string | null;
  setDraggingId: (id: string | null) => void;
  editorsByCard: Map<string, { name: string; color: string }[]>;
  members: Map<string, Member>;
  /** While searching: shows only matching cards (and stops card dragging, whose drop positions assume all are shown). */
  filter: ((card: Card) => boolean) | null;
  onOpenCard: (id: string) => void;
  /** Keyboard moves (Alt+arrows on a card, the arrow buttons on a column header). */
  onMoveCard: (cardId: string, dir: Direction) => void;
  onMoveColumn: (columnId: string, dir: 'left' | 'right') => void;
  readOnly: boolean;
  /** Where a column being dragged would land relative to this one, for the drop marker. */
  dropMarker: 'before' | 'after' | null;
  setDraggingColumnId: (id: string | null) => void;
}

export function Column({
  column,
  state,
  client,
  draggingId,
  setDraggingId,
  editorsByCard,
  members,
  filter,
  onOpenCard,
  onMoveCard,
  onMoveColumn,
  readOnly,
  dropMarker,
  setDraggingColumnId,
}: Props) {
  const listRef = useRef<HTMLUListElement>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(column.name);
  // Ending a rename with Enter or Escape unmounts the input; put focus back on the name so keyboard users keep their place.
  const nameButton = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!renaming && restoreFocus.current) {
      restoreFocus.current = false;
      nameButton.current?.focus();
    }
  }, [renaming]);
  const endRename = (restore: boolean) => {
    restoreFocus.current = restore;
    setRenaming(false);
  };

  const allCards = selectCards(state, column.id);
  const cards = filter ? allCards.filter(filter) : allCards;
  const visibleCount = cards.filter((c) => c.id !== draggingId).length;

  /** Index among the column's cards (minus the dragged one) where a drop at `clientY` would land. */
  function indexAt(clientY: number): number {
    const items = [...(listRef.current?.querySelectorAll<HTMLElement>('[data-card-id]') ?? [])].filter(
      (el) => el.dataset.cardId !== draggingId,
    );
    const i = items.findIndex((el) => {
      const r = el.getBoundingClientRect();
      return clientY < r.top + r.height / 2;
    });
    return i === -1 ? items.length : i;
  }

  function onDragOver(e: React.DragEvent) {
    if (!draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropIndex(indexAt(e.clientY));
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    const id = draggingId ?? e.dataTransfer.getData('text/plain');
    if (id) client.moveCard(id, column.id, indexAt(e.clientY));
    setDropIndex(null);
    setDraggingId(null);
  }

  return (
    <section
      className={`lane${dropMarker ? ` col-drop-${dropMarker}` : ''}`}
      aria-label={column.name}
      data-testid={`column-${column.name}`}
      data-column-id={column.id}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: mouse drag-and-drop of columns; the arrow buttons below reorder columns from the keyboard and by touch */}
      <header
        className="lane-head"
        draggable={!readOnly && !renaming}
        onDragStart={(e) => {
          // Not text/plain: the card lists read that as a card id when something is dropped on them.
          e.dataTransfer.setData('application/x-board-column', column.id);
          e.dataTransfer.effectAllowed = 'move';
          requestAnimationFrame(() => setDraggingColumnId(column.id));
        }}
        onDragEnd={() => setDraggingColumnId(null)}
      >
        {renaming ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              client.renameColumn(column.id, name);
              endRename(true);
            }}
          >
            <input
              autoFocus
              aria-label="Column name"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => endRename(false)}
              onKeyDown={(e) => e.key === 'Escape' && endRename(true)}
            />
          </form>
        ) : (
          <h2>
            {readOnly ? (
              column.name
            ) : (
              <button
                type="button"
                className="title-btn"
                ref={nameButton}
                title="Rename column"
                onClick={() => {
                  setName(column.name);
                  setRenaming(true);
                }}
              >
                {column.name}
              </button>
            )}
          </h2>
        )}
        <span
          className="count"
          role="img"
          aria-label={filter ? `${cards.length} of ${allCards.length} cards match` : `${cards.length} cards`}
        >
          {filter ? `${cards.length}/${allCards.length}` : cards.length}
        </span>
        {!readOnly &&
          (['left', 'right'] as const).map((dir) => (
            <button
              key={dir}
              type="button"
              className="icon-btn move-col"
              data-move-col={dir}
              aria-label={`Move column ${column.name} ${dir}`}
              title={`Move ${dir}`}
              disabled={!columnMoveTarget(state, column.id, dir)}
              onClick={() => onMoveColumn(column.id, dir)}
            >
              {dir === 'left' ? '‹' : '›'}
            </button>
          ))}
        {!readOnly && (
          <button
            type="button"
            className="icon-btn"
            aria-label={`Delete column ${column.name}`}
            title="Delete column"
            onClick={() => {
              if (window.confirm(`Delete "${column.name}" and its ${allCards.length} card(s)?`))
                client.deleteColumn(column.id);
            }}
          >
            ×
          </button>
        )}
      </header>

      <ul
        ref={listRef}
        className={`cards${dropIndex !== null ? ' drop-target' : ''}`}
        data-testid={`cards-${column.name}`}
        onDragOver={onDragOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropIndex(null);
        }}
        onDrop={onDrop}
      >
        {(() => {
          let n = 0; // position among the cards that are NOT being dragged
          return cards.map((card) => {
            const isDragged = card.id === draggingId;
            const line = !isDragged && dropIndex === n++;
            return (
              <li key={card.id} className="slot">
                {line && <div className="drop-line" />}
                <CardTile
                  card={card}
                  dragging={isDragged}
                  readOnly={readOnly || filter !== null}
                  commentCount={selectComments(state, card.id).length + (state.olderComments[card.id]?.count ?? 0)}
                  editors={editorsByCard.get(card.id) ?? []}
                  members={members}
                  onOpen={() => onOpenCard(card.id)}
                  onMove={(dir) => onMoveCard(card.id, dir)}
                  onDragStart={() => requestAnimationFrame(() => setDraggingId(card.id))}
                  onDragEnd={() => {
                    setDraggingId(null);
                    setDropIndex(null);
                  }}
                />
              </li>
            );
          });
        })()}
        {dropIndex !== null && dropIndex >= visibleCount && <li className="drop-line" aria-hidden />}
      </ul>

      {readOnly ? null : adding ? (
        <form
          className="add-card-form"
          onSubmit={(e) => {
            e.preventDefault();
            client.createCard(column.id, title);
            setTitle('');
          }}
        >
          <textarea
            autoFocus
            aria-label="Card title"
            placeholder="What needs doing?"
            rows={2}
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
              if (e.key === 'Escape') {
                setAdding(false);
                setTitle('');
              }
            }}
          />
          <div className="row">
            <button type="submit" className="btn primary">
              Add card
            </button>
            <button type="button" className="btn ghost" onClick={() => setAdding(false)}>
              Done
            </button>
          </div>
        </form>
      ) : (
        <button type="button" className="btn ghost add-card" onClick={() => setAdding(true)}>
          + Add card
        </button>
      )}
    </section>
  );
}
