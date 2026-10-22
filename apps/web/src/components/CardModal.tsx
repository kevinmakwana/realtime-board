import { useEffect, useRef, useState } from 'react';
import {
  LIMITS,
  selectCards,
  selectColumns,
  selectComments,
  type BoardState,
  type Card,
  type Member,
} from '@board/shared';
import type { BoardClient } from '../lib/boardClient';
import { labelHue } from '../lib/cardMeta';
import { useDialogFocus } from '../lib/useDialogFocus';
import { api } from '../api';
import { CommentItem } from './CommentItem';

interface Props {
  card: Card;
  state: BoardState;
  client: BoardClient;
  editors: { name: string; color: string }[];
  members: Member[];
  readOnly: boolean;
  selfUserId: string;
  isOwner: boolean;
  onClose: () => void;
}

export function CardModal({ card, state, client, editors, members, readOnly, selfUserId, isOwner, onClose }: Props) {
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  const [comment, setComment] = useState('');
  const [newLabel, setNewLabel] = useState('');
  // The date is typed in segments, so hold it locally and save only once it is a complete date.
  const [dueDraft, setDueDraft] = useState(card.dueDate ?? '');
  useEffect(() => setDueDraft(card.dueDate ?? ''), [card.dueDate]);
  // The version our draft is based on; if the server moves past it while we have unsaved text, say so.
  const baseline = useRef({ title: card.title, description: card.description, version: card.version });
  const dirty = title !== baseline.current.title || description !== baseline.current.description;
  // Only a change to the text we are editing counts: our own date/label/assignee saves also bump the version.
  const remoteChanged =
    card.version > baseline.current.version &&
    dirty &&
    (card.title !== baseline.current.title || card.description !== baseline.current.description);
  const comments = selectComments(state, card.id);
  const column = state.columns[card.columnId];
  const dialogRef = useDialogFocus<HTMLDivElement>();
  const older = state.olderComments[card.id];
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState('');

  async function loadOlder() {
    if (!older || loadingOlder) return;
    setLoadingOlder(true);
    setOlderError('');
    try {
      const page = await api.cardComments(state.board.id, card.id, older.cursor);
      client.addOlderComments(card.id, page.comments, page.nextCursor);
    } catch (e) {
      setOlderError(e instanceof Error ? e.message : 'Could not load earlier comments');
    } finally {
      setLoadingOlder(false);
    }
  }
  const columns = selectColumns(state);
  const siblings = selectCards(state, card.columnId);
  const place = siblings.findIndex((c) => c.id === card.id);

  useEffect(() => () => client.setEditing(null), [client]);

  function save() {
    const patch: { title?: string; description?: string } = {};
    if (title.trim() && title !== baseline.current.title) patch.title = title;
    if (description !== baseline.current.description) patch.description = description;
    if (Object.keys(patch).length === 0) return;
    client.updateCard(card.id, patch);
    baseline.current = { title: patch.title ?? baseline.current.title, description, version: card.version };
  }

  function reloadFromServer() {
    baseline.current = { title: card.title, description: card.description, version: card.version };
    setTitle(card.title);
    setDescription(card.description);
  }

  function addLabel() {
    const label = newLabel.trim();
    setNewLabel('');
    if (!label || card.labels.length >= LIMITS.labelsPerCard) return;
    if (card.labels.some((l) => l.toLowerCase() === label.toLowerCase())) return;
    client.updateCard(card.id, { labels: [...card.labels, label] });
  }

  function toggleAssignee(userId: string, on: boolean) {
    // People who have left the board can no longer be re-sent, so they drop off the card with this change.
    const onBoard = new Set(members.map((m) => m.userId));
    const rest = card.assigneeIds.filter((id) => id !== userId && onBoard.has(id));
    client.updateCard(card.id, { assigneeIds: on ? [...rest, userId] : rest });
  }

  const focus = () => client.setEditing(card.id);
  const blur = () => client.setEditing(null);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is a mouse shortcut; keyboard users close with Escape (BoardView)
    <div className="scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Card details" tabIndex={-1} ref={dialogRef}>
        <header className="modal-head">
          <span className="in-column">in {column?.name ?? 'column'}</span>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        {editors.length > 0 && (
          <p className="editing-pill wide" role="status">
            {editors.map((e) => e.name).join(', ')} {editors.length > 1 ? 'are' : 'is'} editing this card too
          </p>
        )}
        {remoteChanged && (
          <p className="warn" role="alert">
            Someone saved changes to this card.{' '}
            <button type="button" className="link" onClick={reloadFromServer}>
              Load their version
            </button>{' '}
            (your unsaved text will be replaced) or save yours to overwrite.
          </p>
        )}

        <label className="field">
          Title
          <input
            value={title}
            maxLength={200}
            readOnly={readOnly}
            onChange={(e) => setTitle(e.target.value)}
            onFocus={readOnly ? undefined : focus}
            onBlur={
              readOnly
                ? undefined
                : () => {
                    blur();
                    save();
                  }
            }
          />
        </label>
        <label className="field">
          Description
          <textarea
            rows={5}
            value={description}
            maxLength={5000}
            placeholder={readOnly ? undefined : 'Add more detail…'}
            readOnly={readOnly}
            onChange={(e) => setDescription(e.target.value)}
            onFocus={readOnly ? undefined : focus}
            onBlur={
              readOnly
                ? undefined
                : () => {
                    blur();
                    save();
                  }
            }
          />
        </label>

        {!readOnly && (
          <fieldset className="field-row move-card">
            <legend>Move this card</legend>
            <label className="field">
              Column
              <select value={card.columnId} onChange={(e) => client.moveCard(card.id, e.target.value, 0)}>
                {columns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Position
              <select value={place} onChange={(e) => client.moveCard(card.id, card.columnId, Number(e.target.value))}>
                {siblings.map((c, i) => (
                  <option key={c.id} value={i}>
                    {i + 1} of {siblings.length}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
        )}

        <div className="field-row">
          <label className="field">
            Due date
            <input
              type="date"
              value={dueDraft}
              disabled={readOnly}
              onChange={(e) => {
                setDueDraft(e.target.value);
                if (/^[1-9]\d{3}-\d{2}-\d{2}$/.test(e.target.value) && e.target.value !== card.dueDate) {
                  client.updateCard(card.id, { dueDate: e.target.value });
                }
              }}
              onBlur={() => {
                if (dueDraft === '' && card.dueDate) client.updateCard(card.id, { dueDate: null });
                else setDueDraft(card.dueDate ?? '');
              }}
            />
          </label>
          {!readOnly && card.dueDate && (
            <button type="button" className="btn ghost" onClick={() => client.updateCard(card.id, { dueDate: null })}>
              Clear due date
            </button>
          )}
        </div>

        <div className="field">
          Labels
          <ul className="label-chips editable">
            {card.labels.map((label) => (
              <li key={label} className="label-chip" style={{ '--hue': labelHue(label) } as React.CSSProperties}>
                {label}
                {!readOnly && (
                  <button
                    type="button"
                    className="chip-x"
                    aria-label={`Remove label ${label}`}
                    onClick={() => client.updateCard(card.id, { labels: card.labels.filter((l) => l !== label) })}
                  >
                    ×
                  </button>
                )}
              </li>
            ))}
            {card.labels.length === 0 && <li className="note">No labels.</li>}
          </ul>
          {!readOnly && card.labels.length < LIMITS.labelsPerCard && (
            <input
              aria-label="Add label"
              placeholder="Add a label, press Enter"
              value={newLabel}
              maxLength={LIMITS.labelLength}
              onChange={(e) => setNewLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                addLabel();
              }}
            />
          )}
        </div>

        <fieldset className="assignees">
          <legend>Assignees</legend>
          {members.length === 0 && <p className="note">No members to assign.</p>}
          {members.map((m) => (
            <label key={m.userId} className="assignee-option">
              <input
                type="checkbox"
                checked={card.assigneeIds.includes(m.userId)}
                disabled={readOnly}
                onChange={(e) => toggleAssignee(m.userId, e.target.checked)}
              />
              <span className="avatar avatar-sm" style={{ background: m.color }} aria-hidden>
                {m.name[0]}
              </span>
              {m.name}
            </label>
          ))}
        </fieldset>

        <h3>Comments</h3>
        {older && (
          <div>
            <button type="button" className="btn ghost" disabled={loadingOlder} onClick={loadOlder}>
              {loadingOlder ? 'Loading…' : `Show earlier comments${older.count > 0 ? ` (${older.count})` : ''}`}
            </button>
            {olderError && (
              <p role="alert" className="error">
                {olderError}
              </p>
            )}
          </div>
        )}
        <ul className="comments">
          {comments.map((c) => (
            <CommentItem
              key={c.id}
              comment={c}
              client={client}
              canEdit={!readOnly && c.authorId === selfUserId}
              canDelete={!readOnly && (c.authorId === selfUserId || isOwner)}
            />
          ))}
          {comments.length === 0 && <li className="note">No comments yet.</li>}
        </ul>
        {!readOnly && (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              client.addComment(card.id, comment);
              setComment('');
            }}
          >
            <input
              aria-label="Write a comment"
              placeholder="Write a comment"
              value={comment}
              maxLength={2000}
              onChange={(e) => setComment(e.target.value)}
              onFocus={focus}
              onBlur={blur}
            />
            <button type="submit" className="btn primary">
              Comment
            </button>
          </form>
        )}

        <footer className="modal-foot">
          {!readOnly && (
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                client.deleteCard(card.id);
                onClose();
              }}
            >
              Delete card
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (!readOnly) save();
              onClose();
            }}
          >
            {readOnly ? 'Close' : 'Done'}
          </button>
        </footer>
      </div>
    </div>
  );
}
