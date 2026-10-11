import { useSyncExternalStore } from 'react';
import { getSession, subscribeSession } from './api';
import { BoardPage } from './components/BoardPage';
import { BoardsPage } from './components/BoardsPage';
import { Login, VerifyMagicLink } from './components/Login';
import { usePath } from './router';

export function App() {
  const session = useSyncExternalStore(subscribeSession, getSession);
  const path = usePath();

  if (path === '/auth/verify') return <VerifyMagicLink />;
  if (!session) return <Login />;
  const board = /^\/boards\/([0-9a-f-]{36})$/i.exec(path);
  if (board) return <BoardPage key={board[1]} boardId={board[1]!} session={session} />;
  return <BoardsPage session={session} />;
}
