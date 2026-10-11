import { useRef, useState } from 'react';
import { selectCards, selectComments, type BoardState, type Column as ColumnModel } from '@board/shared';
import type { BoardClient } from '../lib/boardClient';
import { CardTile } from './CardTile';

interface Props {
  column: ColumnModel;
  state: BoardState;
  client: BoardClient;
  draggingId: string | null;
  setDraggingId: (id: string | null) => void;
  editorsByCard: Map<string, { name: string; color: string }[]>;
  onOpenCard: (id: string) => void;
}

export function Column({ column, state, client, draggingId, setDraggingId, editorsByCard, onOpenCard }: Props) {
  const listRef = useRef<HTMLUListElement>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(column.name);

  const cards = selectCards(state, column.id);
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
    <section className="lane" aria-label={column.name} data-testid={`column-${column.name}`}>
      <header className="lane-head">
        {renaming ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              client.renameColumn(column.id, name);
              setRenaming(false);
            }}
          >
            <input
              autoFocus
              aria-label="Column name"
              value={name}
              maxLength={60}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => setRenaming(false)}
              onKeyDown={(e) => e.key === 'Escape' && setRenaming(false)}
            />
          </form>
        ) : (
          <h2
            title="Click to rename"
            onClick={() => {
              setName(column.name);
              setRenaming(true);
            }}
          >
            {column.name}
          </h2>
        )}
        <span className="count" aria-label={`${cards.length} cards`}>
          {cards.length}
        </span>
        <button
          className="icon-btn"
          aria-label={`Delete column ${column.name}`}
          title="Delete column"
          onClick={() => {
            if (window.confirm(`Delete "${column.name}" and its ${cards.length} card(s)?`)) client.deleteColumn(column.id);
          }}
        >
          ×
        </button>
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
                  commentCount={selectComments(state, card.id).length}
                  editors={editorsByCard.get(card.id) ?? []}
                  onOpen={() => onOpenCard(card.id)}
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

      {adding ? (
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
            <button className="btn primary">Add card</button>
            <button type="button" className="btn ghost" onClick={() => setAdding(false)}>
              Done
            </button>
          </div>
        </form>
      ) : (
        <button className="btn ghost add-card" onClick={() => setAdding(true)}>
          + Add card
        </button>
      )}
    </section>
  );
}
