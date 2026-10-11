import type { Board, BoardSnapshot, PublicUser } from '@board/shared';

export interface Session {
  token: string;
  user: PublicUser;
}

const KEY = 'realtime-board.session';
const listeners = new Set<() => void>();
let cached: Session | null | undefined;

export function getSession(): Session | null {
  if (cached !== undefined) return cached;
  try {
    cached = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Session | null;
  } catch {
    cached = null;
  }
  return cached;
}

export function setSession(s: Session | null): void {
  cached = s;
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: session lives for this page only */
  }
  for (const fn of listeners) fn();
}

export const subscribeSession = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const session = getSession();
  const res = await fetch(path, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: {
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(session ? { authorization: `Bearer ${session.token}` } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (res.status === 401 && session) setSession(null);
  if (!res.ok) throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  devLogin: (email: string, name?: string) => request<Session>('/api/auth/dev-login', { body: { email, name } }),
  magicLink: (email: string) => request<{ ok: true }>('/api/auth/magic-link', { body: { email } }),
  verify: (token: string) => request<Session>('/api/auth/verify', { body: { token } }),
  listBoards: () => request<{ boards: Board[] }>('/api/boards'),
  createBoard: (name: string) => request<BoardSnapshot>('/api/boards', { body: { name } }),
};
