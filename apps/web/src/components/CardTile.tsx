import type { Card } from '@board/shared';

interface Props {
  card: Card;
  dragging: boolean;
  commentCount: number;
  editors: { name: string; color: string }[];
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

export function CardTile({ card, dragging, commentCount, editors, onOpen, onDragStart, onDragEnd }: Props) {
  const editing = editors[0];
  return (
    <article
      className={`card${editing ? ' being-edited' : ''}${dragging ? ' dragging' : ''}`}
      data-card-id={card.id}
      data-testid="card"
      draggable
      // biome-ignore lint/a11y/noNoninteractiveTabindex: the card is a focusable control; Enter and Space open it (onKeyDown below)
      tabIndex={0}
      style={editing ? ({ '--editor': editing.color } as React.CSSProperties) : undefined}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen();
        }
      }}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', card.id);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
    >
      <p className="card-title">{card.title}</p>
      {(commentCount > 0 || card.description) && (
        <p className="card-meta">
          {card.description && <span title="Has a description">Description</span>}
          {commentCount > 0 && (
            <span>
              {commentCount} comment{commentCount === 1 ? '' : 's'}
            </span>
          )}
        </p>
      )}
      {editing && (
        <p className="editing-pill" role="status" data-testid="editing-indicator">
          {editors.map((e) => e.name).join(', ')} {editors.length > 1 ? 'are' : 'is'} editing
        </p>
      )}
    </article>
  );
}
