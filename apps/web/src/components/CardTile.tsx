import type { Card, Member } from '@board/shared';
import { dueStatus, formatDue, labelHue } from '../lib/cardMeta';

interface Props {
  card: Card;
  dragging: boolean;
  readOnly: boolean;
  commentCount: number;
  editors: { name: string; color: string }[];
  members: Map<string, Member>;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}

export function CardTile({
  card,
  dragging,
  readOnly,
  commentCount,
  editors,
  members,
  onOpen,
  onDragStart,
  onDragEnd,
}: Props) {
  const editing = editors[0];
  return (
    <article
      className={`card${editing ? ' being-edited' : ''}${dragging ? ' dragging' : ''}`}
      data-card-id={card.id}
      data-testid="card"
      draggable={!readOnly}
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
      {card.labels.length > 0 && (
        <ul className="label-chips">
          {card.labels.map((label) => (
            <li
              key={label}
              className="label-chip"
              data-testid="label"
              style={{ '--hue': labelHue(label) } as React.CSSProperties}
            >
              {label}
            </li>
          ))}
        </ul>
      )}
      <p className="card-title">{card.title}</p>
      {(commentCount > 0 || card.description || card.dueDate || card.assigneeIds.length > 0) && (
        <div className="card-meta">
          {card.dueDate && (
            <span className={`due ${dueStatus(card.dueDate)}`} data-testid="due" title="Due date">
              {formatDue(card.dueDate)}
            </span>
          )}
          {card.description && <span title="Has a description">Description</span>}
          {commentCount > 0 && (
            <span>
              {commentCount} comment{commentCount === 1 ? '' : 's'}
            </span>
          )}
          {card.assigneeIds.length > 0 && (
            <ul className="card-avatars" aria-label="Assigned to">
              {card.assigneeIds.map((id) => {
                const member = members.get(id);
                return (
                  <li
                    key={id}
                    className="avatar avatar-sm"
                    data-testid="assignee"
                    title={member?.name ?? 'Former member'}
                    style={{ background: member?.color ?? '#7a8699' }}
                  >
                    {member?.name[0] ?? '?'}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      {editing && (
        <p className="editing-pill" role="status" data-testid="editing-indicator">
          {editors.map((e) => e.name).join(', ')} {editors.length > 1 ? 'are' : 'is'} editing
        </p>
      )}
    </article>
  );
}
