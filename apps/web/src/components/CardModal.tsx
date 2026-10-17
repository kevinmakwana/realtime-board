import { useEffect, useRef, useState } from 'react';
import { selectComments, type BoardState, type Card } from '@board/shared';
import type { BoardClient } from '../lib/boardClient';

interface Props {
  card: Card;
  state: BoardState;
  client: BoardClient;
  editors: { name: string; color: string }[];
  onClose: () => void;
}

export function CardModal({ card, state, client, editors, onClose }: Props) {
  const [title, setTitle] = useState(card.title);
  const [description, setDescription] = useState(card.description);
  const [comment, setComment] = useState('');
  // The version our draft is based on; if the server moves past it while we have unsaved text, say so.
  const baseline = useRef({ title: card.title, description: card.description, version: card.version });
  const dirty = title !== baseline.current.title || description !== baseline.current.description;
  const remoteChanged = card.version > baseline.current.version && dirty;
  const comments = selectComments(state, card.id);
  const column = state.columns[card.columnId];

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

  const focus = () => client.setEditing(card.id);
  const blur = () => client.setEditing(null);

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label="Card details">
        <header className="modal-head">
          <span className="in-column">in {column?.name ?? 'column'}</span>
          <button className="icon-btn" aria-label="Close" onClick={onClose}>
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
            <button className="link" onClick={reloadFromServer}>
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
            onChange={(e) => setTitle(e.target.value)}
            onFocus={focus}
            onBlur={() => {
              blur();
              save();
            }}
          />
        </label>
        <label className="field">
          Description
          <textarea
            rows={5}
            value={description}
            maxLength={5000}
            placeholder="Add more detail…"
            onChange={(e) => setDescription(e.target.value)}
            onFocus={focus}
            onBlur={() => {
              blur();
              save();
            }}
          />
        </label>

        <h3>Comments</h3>
        <ul className="comments">
          {comments.map((c) => (
            <li key={c.id}>
              <strong>{c.authorName}</strong>
              <time dateTime={c.createdAt}>
                {new Date(c.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </time>
              <p>{c.body}</p>
            </li>
          ))}
          {comments.length === 0 && <li className="note">No comments yet.</li>}
        </ul>
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
          <button className="btn primary">Comment</button>
        </form>

        <footer className="modal-foot">
          <button
            className="btn danger"
            onClick={() => {
              client.deleteCard(card.id);
              onClose();
            }}
          >
            Delete card
          </button>
          <button className="btn" onClick={() => (save(), onClose())}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}
