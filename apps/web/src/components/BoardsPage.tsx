import { useEffect, useState } from 'react';
import type { BoardWithRole } from '@board/shared';
import { api, setSession, type Session } from '../api';
import { navigate } from '../router';

export function BoardsPage({ session }: { session: Session }) {
  const [boards, setBoards] = useState<BoardWithRole[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .listBoards()
      .then((r) => setBoards(r.boards))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not load boards'));
  }, []);

  async function create(ev: React.FormEvent) {
    ev.preventDefault();
    if (!name.trim()) return;
    try {
      const snap = await api.createBoard(name.trim());
      navigate(`/boards/${snap.board.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the board');
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <strong className="brand">Realtime Board</strong>
        <span className="spacer" />
        <span className="who">
          <span className="avatar" style={{ background: session.user.color }} aria-hidden>
            {session.user.name[0]}
          </span>
          {session.user.name}
        </span>
        <button type="button" className="btn ghost" onClick={() => setSession(null)}>
          Sign out
        </button>
      </header>
      <main className="boards">
        <h1>Boards</h1>
        <form className="row" onSubmit={create}>
          <input
            placeholder="Name a new board"
            aria-label="New board name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
          />
          <button type="submit" className="btn primary">
            Create board
          </button>
        </form>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {boards?.length === 0 && <p className="note">No boards yet. Name one above to get started.</p>}
        <ul className="board-list">
          {boards?.map((b) => (
            <li key={b.id}>
              <a
                href={`/boards/${b.id}`}
                onClick={(e) => {
                  e.preventDefault();
                  navigate(`/boards/${b.id}`);
                }}
              >
                {b.name}
              </a>
              <span className="role-badge">{b.role}</span>
              <time dateTime={b.createdAt}>{new Date(b.createdAt).toLocaleDateString()}</time>
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
