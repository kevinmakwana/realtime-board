import { useCallback, useEffect, useState } from 'react';
import type { GrantableRole, Invite, Member, Role } from '@board/shared';
import { api } from '../api';
import { navigate } from '../router';

interface Props {
  boardId: string;
  role: Role;
  selfUserId: string;
  onClose: () => void;
}

const messageOf = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

export function ShareDialog({ boardId, role, selfUserId, onClose }: Props) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<GrantableRole>('editor');
  const isOwner = role === 'owner';

  const load = useCallback(async () => {
    try {
      const r = await api.listMembers(boardId);
      setMembers(r.members);
      setInvites(r.invites ?? []);
      setError('');
    } catch (e) {
      setError(messageOf(e));
    }
  }, [boardId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function run(action: () => Promise<unknown>) {
    try {
      await action();
      await load();
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function invite(ev: React.FormEvent) {
    ev.preventDefault();
    if (!email.trim()) return;
    await run(async () => {
      await api.addMember(boardId, email.trim(), inviteRole);
      setEmail('');
    });
  }

  async function remove() {
    if (!window.confirm('Delete this board for everyone? Its cards and comments go with it. This cannot be undone.'))
      return;
    try {
      await api.deleteBoard(boardId);
      navigate('/');
    } catch (e) {
      setError(messageOf(e));
    }
  }

  async function leave() {
    try {
      await api.removeMember(boardId, selfUserId);
      navigate('/');
    } catch (e) {
      setError(messageOf(e));
    }
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is a mouse shortcut; keyboard users close with Escape
    <div className="scrim" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal share" role="dialog" aria-modal="true" aria-label="Share board">
        <header className="modal-head">
          <h2>Share this board</h2>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </header>

        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}

        <ul className="members" data-testid="members">
          {members.map((m) => (
            <li key={m.userId} className="member-row" data-testid="member">
              <span className="avatar" style={{ background: m.color }} aria-hidden>
                {m.name[0]}
              </span>
              <span className="member-name">
                {m.name}
                {m.userId === selfUserId && ' (you)'}
                {m.email && <small>{m.email}</small>}
              </span>
              {isOwner && m.role !== 'owner' ? (
                <>
                  <select
                    aria-label={`Role for ${m.name}`}
                    value={m.role}
                    onChange={(e) =>
                      void run(() => api.setMemberRole(boardId, m.userId, e.target.value as GrantableRole))
                    }
                  >
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <button
                    type="button"
                    className="btn ghost"
                    aria-label={`Remove ${m.name}`}
                    onClick={() => void run(() => api.removeMember(boardId, m.userId))}
                  >
                    Remove
                  </button>
                </>
              ) : (
                <span className="role-badge">{m.role}</span>
              )}
            </li>
          ))}
        </ul>

        {isOwner && invites.length > 0 && (
          <>
            <h3>Pending invites</h3>
            <ul className="members" data-testid="invites">
              {invites.map((i) => (
                <li key={i.email} className="member-row">
                  <span className="member-name">{i.email}</span>
                  <span className="role-badge">{i.role}</span>
                  <button
                    type="button"
                    className="btn ghost"
                    aria-label={`Withdraw invite for ${i.email}`}
                    onClick={() => void run(() => api.removeInvite(boardId, i.email))}
                  >
                    Withdraw
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        {isOwner ? (
          <form className="row invite-form" onSubmit={invite}>
            <input
              type="email"
              aria-label="Invite by email"
              placeholder="name@example.com"
              value={email}
              maxLength={200}
              onChange={(e) => setEmail(e.target.value)}
            />
            <select
              aria-label="Invite role"
              value={inviteRole}
              onChange={(e) => setInviteRole(e.target.value as GrantableRole)}
            >
              <option value="editor">Editor</option>
              <option value="viewer">Viewer</option>
            </select>
            <button type="submit" className="btn primary">
              Invite
            </button>
          </form>
        ) : (
          <footer className="modal-foot">
            <button type="button" className="btn danger" onClick={() => void leave()}>
              Leave board
            </button>
          </footer>
        )}

        {isOwner && (
          <section className="danger-zone">
            <h3>Delete this board</h3>
            <p className="note">Deletes the board, its cards and comments for everyone. This cannot be undone.</p>
            <button type="button" className="btn danger" onClick={() => void remove()}>
              Delete board
            </button>
          </section>
        )}
      </div>
    </div>
  );
}
