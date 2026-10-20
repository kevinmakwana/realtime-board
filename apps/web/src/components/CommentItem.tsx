import { useState } from 'react';
import type { Comment } from '@board/shared';
import type { BoardClient } from '../lib/boardClient';

interface Props {
  comment: Comment;
  client: BoardClient;
  /** Only the author edits. */
  canEdit: boolean;
  /** The author, or the board owner moderating. */
  canDelete: boolean;
}

export function CommentItem({ comment, client, canEdit, canDelete }: Props) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(comment.body);

  function save() {
    client.editComment(comment.id, text);
    setEditing(false);
  }

  return (
    <li data-testid="comment">
      <strong>{comment.authorName}</strong>
      <time dateTime={comment.createdAt}>
        {new Date(comment.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
      </time>
      {comment.editedAt && (
        <span className="edited" title={`Edited ${new Date(comment.editedAt).toLocaleString()}`}>
          (edited)
        </span>
      )}
      {editing ? (
        <form
          className="comment-edit"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <textarea
            autoFocus
            aria-label="Edit comment text"
            rows={2}
            maxLength={2000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
              if (e.key === 'Escape') {
                e.stopPropagation(); // keep the card modal open
                setEditing(false);
              }
            }}
          />
          <div className="row">
            <button type="submit" className="btn primary" aria-label="Save comment">
              Save
            </button>
            <button type="button" className="btn ghost" aria-label="Cancel edit" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <p>{comment.body}</p>
      )}
      {!editing && (canEdit || canDelete) && (
        <span className="comment-actions">
          {canEdit && (
            <button
              type="button"
              className="link"
              aria-label="Edit comment"
              onClick={() => {
                setText(comment.body);
                setEditing(true);
              }}
            >
              Edit
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              className="link"
              aria-label="Delete comment"
              onClick={() => client.deleteComment(comment.id)}
            >
              Delete
            </button>
          )}
        </span>
      )}
    </li>
  );
}
