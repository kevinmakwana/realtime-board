import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Role } from '@board/shared';
import { api } from '../src/api';
import { BoardView } from '../src/components/BoardView';
import type { BoardViewModel } from '../src/lib/boardClient';
import { ada, ADA, fakeClient, grace, GRACE, makeCard, makeComment, makeState } from './componentHelpers';

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  api: { listMembers: vi.fn(), activity: vi.fn() },
}));

const session = { token: 't', user: { id: ADA, name: 'Ada Lovelace', color: '#0091ff' } };

function setup(opts: { role?: Role | null; status?: BoardViewModel['status'] } = {}) {
  const cards = [
    makeCard(1, { title: 'Fix login redirect', labels: ['bug'] }),
    makeCard(2, { title: 'Write release notes', assigneeIds: [GRACE] }),
    makeCard(3, { title: 'Design onboarding' }),
  ];
  const state = makeState(cards, [makeComment(1, cards[2]!.id, { body: 'check the Safari layout' })]);
  const vm: BoardViewModel = {
    status: opts.status ?? 'live',
    instance: 'a',
    state,
    presence: [],
    cursors: [],
    selfSocketId: 's1',
    role: opts.role === undefined ? 'owner' : opts.role,
  };
  const client = fakeClient();
  render(<BoardView client={client} vm={vm} state={state} session={session} />);
  return { client, cards };
}

beforeEach(() => {
  vi.mocked(api.listMembers).mockResolvedValue({ members: [ada, grace] });
  vi.mocked(api.activity).mockResolvedValue({
    entries: [
      {
        seq: 5,
        ts: new Date().toISOString(),
        actorId: ADA,
        actorName: 'Ada Lovelace',
        text: 'Ada Lovelace added card “Fix login redirect”',
      },
    ],
  });
});

const cardTitles = () => screen.getAllByTestId('card').map((c) => c.querySelector('.card-title')?.textContent);

describe('BoardView', () => {
  it('shows the board name, its columns and cards, and the connection state', () => {
    setup();
    expect(screen.getByTestId('board-title')).toHaveTextContent('Roadmap');
    expect(screen.getByRole('region', { name: 'To do' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Done' })).toBeInTheDocument();
    expect(cardTitles()).toEqual(['Fix login redirect', 'Write release notes', 'Design onboarding']);
    expect(screen.getByTestId('connection')).toHaveTextContent('Live on a');
  });

  it('says when it is reconnecting or signed out', () => {
    setup({ status: 'reconnecting' });
    expect(screen.getByTestId('connection')).toHaveTextContent('Reconnecting…');
  });

  describe('search', () => {
    it('narrows the board by text, label, assignee name and comment, and counts matches', async () => {
      const user = userEvent.setup();
      setup();
      const search = screen.getByRole('searchbox', { name: 'Search cards' });
      expect(screen.queryByTestId('search-count')).not.toBeInTheDocument();

      await user.type(search, 'login');
      expect(cardTitles()).toEqual(['Fix login redirect']);
      expect(screen.getByTestId('search-count')).toHaveTextContent('1 match');

      await user.clear(search);
      await user.type(search, 'bug'); // a label
      expect(cardTitles()).toEqual(['Fix login redirect']);

      await user.clear(search);
      await user.type(search, 'safari');
      expect(cardTitles()).toEqual(['Design onboarding']);

      await user.clear(search);
      await waitFor(() => expect(api.listMembers).toHaveBeenCalled());
      await user.type(search, 'grace'); // an assignee, by name
      await waitFor(() => expect(cardTitles()).toEqual(['Write release notes']));

      await user.clear(search);
      await user.type(search, 'zzz');
      expect(screen.queryAllByTestId('card')).toHaveLength(0);
      expect(screen.getByTestId('search-count')).toHaveTextContent('0 matches');
    });

    it('Escape in the search box clears it without closing anything else', async () => {
      const user = userEvent.setup();
      setup();
      await user.click(screen.getByText('Fix login redirect'));
      expect(screen.getByRole('dialog', { name: 'Card details' })).toBeInTheDocument();
      const search = screen.getByRole('searchbox', { name: 'Search cards' });
      await user.type(search, 'abc{Escape}');
      expect(search).toHaveValue('');
      expect(screen.getByRole('dialog', { name: 'Card details' })).toBeInTheDocument();
    });
  });

  describe('card modal', () => {
    it('opens from a card, shows its members to assign, and closes with Escape', async () => {
      const user = userEvent.setup();
      setup();
      await user.click(screen.getByText('Write release notes'));
      const dialog = screen.getByRole('dialog', { name: 'Card details' });
      expect(within(dialog).getByLabelText('Title')).toHaveValue('Write release notes');
      await waitFor(() => expect(within(dialog).getByRole('checkbox', { name: 'Grace Hopper' })).toBeChecked());
      await user.keyboard('{Escape}');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  describe('activity', () => {
    it('toggles a feed of what happened, and the close button hides it', async () => {
      const user = userEvent.setup();
      setup();
      const toggle = screen.getByTestId('activity-toggle');
      expect(toggle).toHaveAttribute('aria-pressed', 'false');
      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-pressed', 'true');
      expect(await screen.findByTestId('activity-item')).toHaveTextContent(
        'Ada Lovelace added card “Fix login redirect”',
      );
      await user.click(screen.getByRole('button', { name: 'Close activity' }));
      expect(screen.queryByTestId('activity')).not.toBeInTheDocument();
    });
  });

  describe('roles', () => {
    it('lets an owner rename the board, add columns and open Share', async () => {
      const user = userEvent.setup();
      const { client } = setup({ role: 'owner' });
      await user.click(screen.getByRole('button', { name: 'Roadmap' }));
      const name = screen.getByRole('textbox', { name: 'Board name' });
      await user.clear(name);
      await user.type(name, 'Q4{Enter}');
      expect(client.renameBoard).toHaveBeenCalledWith('Q4');

      await user.click(screen.getByRole('button', { name: '+ Add column' }));
      await user.type(screen.getByRole('textbox', { name: 'Column name' }), 'Review{Enter}');
      expect(client.createColumn).toHaveBeenCalledWith('Review');

      expect(screen.getByTestId('share')).toBeInTheDocument();
    });

    it('lets an editor change cards but not rename the board', () => {
      setup({ role: 'editor' });
      expect(screen.queryByRole('button', { name: 'Roadmap' })).not.toBeInTheDocument();
      expect(screen.getByTestId('board-title')).toHaveTextContent('Roadmap');
      expect(screen.getAllByRole('button', { name: '+ Add card' })).toHaveLength(2);
      expect(screen.getAllByTestId('card')[0]).toHaveAttribute('draggable', 'true');
    });

    it('gives a viewer a read-only board', async () => {
      const user = userEvent.setup();
      setup({ role: 'viewer' });
      expect(screen.queryByRole('button', { name: '+ Add card' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '+ Add column' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Delete column/ })).not.toBeInTheDocument();
      expect(screen.getAllByTestId('card')[0]).toHaveAttribute('draggable', 'false');
      await user.click(screen.getByText('Fix login redirect'));
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getByLabelText('Title')).toHaveAttribute('readonly');
    });
  });

  it('closes a card that is deleted by someone else while it is open', async () => {
    const user = userEvent.setup();
    const cards = [makeCard(1)];
    const client = fakeClient();
    const vm = (state: ReturnType<typeof makeState>): BoardViewModel => ({
      status: 'live',
      instance: 'a',
      state,
      presence: [],
      cursors: [],
      selfSocketId: 's1',
      role: 'owner',
    });
    const before = makeState(cards);
    const { rerender } = render(<BoardView client={client} vm={vm(before)} state={before} session={session} />);
    await user.click(screen.getByText('Card 1'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    const after = makeState([]);
    rerender(<BoardView client={client} vm={vm(after)} state={after} session={session} />);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
