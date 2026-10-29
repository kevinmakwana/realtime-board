import { useMemo, useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { keyForIndex, selectCards, selectColumns, type BoardState, type Role } from '@board/shared';
import { api } from '../src/api';
import { BoardView } from '../src/components/BoardView';
import type { BoardViewModel } from '../src/lib/boardClient';
import {
  ada,
  ADA,
  COL_DONE,
  COL_TODO,
  fakeClient,
  grace,
  GRACE,
  makeCard,
  makeComment,
  makeState,
} from './componentHelpers';

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  api: { listMembers: vi.fn(), activity: vi.fn() },
}));

const session = { token: 't', user: { id: ADA, name: 'Ada Lovelace', color: '#0091ff' } };

function setup(opts: { role?: Role | null; status?: BoardViewModel['status']; queued?: number } = {}) {
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
    queued: opts.queued ?? 0,
  };
  const client = fakeClient();
  render(<BoardView client={client} vm={vm} state={state} session={session} />);
  return { client, cards };
}

beforeEach(() => {
  vi.clearAllMocks();
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

  it.each([
    ['reconnecting', 'Reconnecting…'],
    ['unauthorized', 'Signed out'],
  ] as const)('says so when the connection is %s', (status, text) => {
    setup({ status });
    expect(screen.getByTestId('connection')).toHaveTextContent(text);
  });

  it('says how many changes are waiting while offline', () => {
    setup({ status: 'reconnecting', queued: 2 });
    expect(screen.getByTestId('connection')).toHaveTextContent('Reconnecting… · 2 changes waiting');
  });

  it('also says so while live, when changes are still being sent', () => {
    setup({ status: 'live', queued: 1 });
    expect(screen.getByTestId('connection')).toHaveTextContent('Live on a · 1 change waiting');
  });

  it('does not mention waiting changes when there are none', () => {
    setup({ status: 'reconnecting' });
    expect(screen.getByTestId('connection')).not.toHaveTextContent('waiting');
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
      queued: 0,
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

describe('BoardView keyboard and screen-reader support', () => {
  it('moves the focused card with Alt+arrows, announces where it went and keeps it focused', async () => {
    const user = userEvent.setup();
    const { client, cards } = setup();
    screen.getByText('Write release notes').closest<HTMLElement>('[data-testid=card]')?.focus();

    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(client.moveCard).toHaveBeenLastCalledWith(cards[1]?.id, COL_TODO, 0);
    expect(screen.getByTestId('move-announcement')).toHaveTextContent(
      'Moved “Write release notes” to To do, position 1 of 3',
    );

    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    expect(client.moveCard).toHaveBeenLastCalledWith(cards[1]?.id, COL_DONE, 0);
    expect(screen.getByTestId('move-announcement')).toHaveTextContent(
      'Moved “Write release notes” to Done, position 1 of 1',
    );
  });

  it('does nothing at the edge of the board', async () => {
    const user = userEvent.setup();
    const { client } = setup();
    screen.getByText('Fix login redirect').closest<HTMLElement>('[data-testid=card]')?.focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}{Alt>}{ArrowLeft}{/Alt}');
    expect(client.moveCard).not.toHaveBeenCalled();
    expect(screen.getByTestId('move-announcement')).toBeEmptyDOMElement();
  });

  it('moves a column from its header buttons and keeps focus on the button', async () => {
    const user = userEvent.setup();
    const { client } = setup();
    await user.click(screen.getByRole('button', { name: 'Move column To do right' }));
    expect(client.moveColumn).toHaveBeenCalledWith(COL_TODO, 1);
    expect(screen.getByTestId('move-announcement')).toHaveTextContent('Moved column “To do” to position 2 of 2');
    expect(screen.getByRole('button', { name: 'Move column To do right' })).toHaveFocus();
  });

  it('describes the shortcut once for assistive technology', () => {
    setup();
    expect(document.getElementById('move-help')).toHaveTextContent('Alt with the arrow keys');
  });

  it('puts focus in the card dialog, keeps Tab inside it, and gives focus back to the card on Escape', async () => {
    const user = userEvent.setup();
    setup();
    const tile = screen.getByText('Fix login redirect').closest<HTMLElement>('[data-testid=card]')!;
    tile.focus();
    await user.keyboard('{Enter}');
    const dialog = screen.getByRole('dialog', { name: 'Card details' });
    expect(dialog).toHaveFocus();

    await user.tab({ shift: true }); // from the dialog itself back to the last control
    expect(within(dialog).getByRole('button', { name: 'Done' })).toHaveFocus();
    await user.tab(); // and forward again wraps to the first
    expect(within(dialog).getAllByRole('button', { name: 'Close' })[0]).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(tile).toHaveFocus();
  });
});

/** A board whose fake client really applies moves, so the DOM reorders the way it does for a person. */
function LiveBoard() {
  const [state, setState] = useState<BoardState>(() =>
    makeState([makeCard(1, { title: 'One' }), makeCard(2, { title: 'Two' }), makeCard(3, { title: 'Three' })]),
  );
  const client = useMemo(() => {
    const c = fakeClient();
    c.moveCard.mockImplementation((id: string, columnId: string, index: number) => {
      setState((s) => {
        const others = selectCards(s, columnId).filter((x) => x.id !== id);
        const card = { ...s.cards[id]!, columnId, position: keyForIndex(others, index) };
        return { ...s, cards: { ...s.cards, [id]: card } };
      });
      return true;
    });
    c.moveColumn.mockImplementation((id: string, index: number) => {
      setState((s) => {
        const others = selectColumns(s).filter((x) => x.id !== id);
        return { ...s, columns: { ...s.columns, [id]: { ...s.columns[id]!, position: keyForIndex(others, index) } } };
      });
      return true;
    });
    return c;
  }, []);
  const vm: BoardViewModel = {
    status: 'live',
    instance: 'a',
    state,
    presence: [],
    cursors: [],
    selfSocketId: 's1',
    role: 'owner',
    queued: 0,
  };
  return <BoardView client={client} vm={vm} state={state} session={session} />;
}

describe('focus after a keyboard move, on a board that really reorders', () => {
  it('keeps focus on a card that moved to another column', async () => {
    const user = userEvent.setup();
    render(<LiveBoard />);
    screen.getByText('Two').closest<HTMLElement>('[data-testid=card]')?.focus();
    await user.keyboard('{Alt>}{ArrowRight}{/Alt}');
    const done = screen.getByTestId('cards-Done');
    const moved = within(done).getByText('Two').closest<HTMLElement>('[data-testid=card]');
    expect(moved).toHaveFocus();
    await user.keyboard('{Alt>}{ArrowLeft}{/Alt}');
    expect(screen.getByText('Two').closest('[data-testid=card]')).toHaveFocus();
  });

  it('keeps focus on a button of the column after it moved', async () => {
    const user = userEvent.setup();
    render(<LiveBoard />);
    await user.click(screen.getByRole('button', { name: 'Move column To do right' }));
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Done', 'To do']);
    // "To do" is now last, so its right button is disabled and focus lands on the left one.
    expect(screen.getByRole('button', { name: 'Move column To do right' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move column To do left' })).toHaveFocus();
  });

  it('falls back to the other arrow when the column reaches the end', async () => {
    const user = userEvent.setup();
    render(<LiveBoard />);
    await user.click(screen.getByRole('button', { name: 'Move column Done left' }));
    expect(screen.getAllByRole('region').map((r) => r.getAttribute('aria-label'))).toEqual(['Done', 'To do']);
    // "Done" is now first: its left button is disabled, so focus lands on the right one.
    expect(screen.getByRole('button', { name: 'Move column Done right' })).toHaveFocus();
  });
});

describe('a move the client refuses', () => {
  it('is not announced as done', async () => {
    const user = userEvent.setup();
    const { client } = setup();
    client.moveCard.mockReturnValue(false);
    screen.getByText('Write release notes').closest<HTMLElement>('[data-testid=card]')?.focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(client.moveCard).toHaveBeenCalled();
    expect(screen.getByTestId('move-announcement')).toBeEmptyDOMElement();
  });
});
