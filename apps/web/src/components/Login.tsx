import { useEffect, useRef, useState } from 'react';
import { api, setSession } from '../api';
import { navigate } from '../router';

// Fictional demo people: one click signs in as them (dev login), so two windows can be two users.
const PERSONAS = [
  { name: 'Ada Lovelace', email: 'ada@example.test' },
  { name: 'Grace Hopper', email: 'grace@example.test' },
  { name: 'Linus Demo', email: 'linus@example.test' },
];

export function Login() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);

  async function devLogin(e: string, name?: string) {
    setBusy(true);
    setError('');
    try {
      setSession(await api.devLogin(e, name));
      navigate('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not sign in');
    } finally {
      setBusy(false);
    }
  }

  async function magic(ev: React.FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.magicLink(email);
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the link');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <section className="login-card">
        <h1>Realtime Board</h1>
        <p className="lede">A kanban board where everyone's changes, cursors and edits show up as they happen.</p>

        <h2>Sign in as a demo person</h2>
        <div className="personas">
          {PERSONAS.map((p) => (
            <button
              type="button"
              key={p.email}
              className="btn"
              disabled={busy}
              onClick={() => void devLogin(p.email, p.name)}
            >
              {p.name}
            </button>
          ))}
        </div>

        <h2>Or get a magic link</h2>
        {sent ? (
          <p role="status" className="note">
            Link created. Look for it in the server console (this demo prints it instead of sending email), then open it
            here.
          </p>
        ) : (
          <form onSubmit={magic} className="row">
            <input
              type="email"
              required
              placeholder="you@example.test"
              aria-label="Email address"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <button type="submit" className="btn primary" disabled={busy}>
              Create link
            </button>
          </form>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}

export function VerifyMagicLink() {
  const [error, setError] = useState('');
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return; // StrictMode runs effects twice; the token is single-use
    started.current = true;
    const token = new URLSearchParams(location.search).get('token') ?? '';
    api
      .verify(token)
      .then((s) => {
        setSession(s);
        navigate('/');
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not verify the link'));
  }, []);

  return (
    <main className="login">
      <section className="login-card">
        {error ? (
          <>
            <h1>That link did not work</h1>
            <p role="alert" className="error">
              {error}
            </p>
            <button type="button" className="btn primary" onClick={() => navigate('/')}>
              Back to sign in
            </button>
          </>
        ) : (
          <h1>Signing you in…</h1>
        )}
      </section>
    </main>
  );
}
