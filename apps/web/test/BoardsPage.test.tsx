import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardWithRole } from '@board/shared';
import { api } from '../src/api';
import { BoardsPage } from '../src/components/BoardsPage';
import { uid } from './componentHelpers';

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  api: { listBoards: vi.fn(), createBoard: vi.fn() },
}));

const session = { token: 't', user: { id: uid(2), name: 'Ada Lovelace', color: '#0091ff' } };
const board = (n: number): BoardWithRole => ({
  id: uid(n),
  name: `Board ${n}`,
  createdAt: '2026-01-01T00:00:00.000Z',
  role: 'owner',
});

beforeEach(() => vi.clearAllMocks());

describe('BoardsPage paging', () => {
  it('shows the first page, with no button when there is nothing more', async () => {
    vi.mocked(api.listBoards).mockResolvedValue({ boards: [board(1), board(2)], nextCursor: null });
    render(<BoardsPage session={session} />);
    expect(await screen.findByRole('link', { name: 'Board 1' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Board 2' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Load more/ })).not.toBeInTheDocument();
  });

  it('loads the next page on request, appends it and hides the button after the last page', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listBoards)
      .mockResolvedValueOnce({ boards: [board(1)], nextCursor: 'c1' })
      .mockResolvedValueOnce({ boards: [board(2)], nextCursor: 'c2' })
      .mockResolvedValueOnce({ boards: [board(3)], nextCursor: null });
    render(<BoardsPage session={session} />);
    await screen.findByRole('link', { name: 'Board 1' });

    await user.click(screen.getByRole('button', { name: 'Load more boards' }));
    await screen.findByRole('link', { name: 'Board 2' });
    expect(api.listBoards).toHaveBeenLastCalledWith('c1');
    expect(screen.getByRole('link', { name: 'Board 1' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Load more boards' }));
    await screen.findByRole('link', { name: 'Board 3' });
    expect(api.listBoards).toHaveBeenLastCalledWith('c2');
    expect(screen.queryByRole('button', { name: /Load more/ })).not.toBeInTheDocument();
  });

  it('keeps what is shown, and the button, when a page fails to load', async () => {
    const user = userEvent.setup();
    vi.mocked(api.listBoards)
      .mockResolvedValueOnce({ boards: [board(1)], nextCursor: 'c1' })
      .mockRejectedValueOnce(new Error('Network down'));
    render(<BoardsPage session={session} />);
    await screen.findByRole('link', { name: 'Board 1' });
    await user.click(screen.getByRole('button', { name: 'Load more boards' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Network down');
    expect(screen.getByRole('link', { name: 'Board 1' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Load more boards' })).toBeEnabled();
  });
});
