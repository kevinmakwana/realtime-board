import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Card } from '@board/shared';
import { Column } from '../src/components/Column';
import { COL_TODO, fakeClient, makeCard, makeComment, makeState } from './componentHelpers';

function setup(opts: { cards?: Card[]; readOnly?: boolean; filter?: ((c: Card) => boolean) | null } = {}) {
  const cards = opts.cards ?? [makeCard(1), makeCard(2)];
  const state = makeState(cards, cards[0] ? [makeComment(1, cards[0].id)] : []);
  const client = fakeClient();
  const onOpenCard = vi.fn();
  render(
    <Column
      column={state.columns[COL_TODO]!}
      state={state}
      client={client}
      draggingId={null}
      setDraggingId={vi.fn()}
      editorsByCard={new Map()}
      members={new Map()}
      filter={opts.filter ?? null}
      onOpenCard={onOpenCard}
      readOnly={opts.readOnly ?? false}
      dropMarker={null}
      setDraggingColumnId={vi.fn()}
    />,
  );
  return { client, onOpenCard };
}

afterEach(() => vi.restoreAllMocks());

describe('Column', () => {
  it('lists its cards in order with a count and the comment count of each', () => {
    setup();
    const list = screen.getByTestId('cards-To do');
    expect(
      within(list)
        .getAllByTestId('card')
        .map((c) => c.querySelector('.card-title')?.textContent),
    ).toEqual(['Card 1', 'Card 2']);
    expect(screen.getByRole('img', { name: '2 cards' })).toHaveTextContent('2');
    expect(within(list).getByText('1 comment')).toBeInTheDocument();
  });

  it('opens the card that was clicked', async () => {
    const { onOpenCard } = setup();
    await userEvent.click(screen.getByText('Card 2'));
    expect(onOpenCard).toHaveBeenCalledWith(makeCard(2).id);
  });

  it('adds a card with Enter, keeps the form open for the next one, and closes on Escape', async () => {
    const user = userEvent.setup();
    const { client } = setup({ cards: [] });
    await user.click(screen.getByRole('button', { name: '+ Add card' }));
    const input = screen.getByRole('textbox', { name: 'Card title' });
    await user.type(input, 'Write docs{Enter}');
    expect(client.createCard).toHaveBeenCalledWith(COL_TODO, 'Write docs');
    expect(input).toHaveValue('');
    await user.type(input, 'second');
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Card title' })).not.toBeInTheDocument();
    expect(client.createCard).toHaveBeenCalledTimes(1);
  });

  it('Shift+Enter makes a new line instead of submitting', async () => {
    const user = userEvent.setup();
    const { client } = setup({ cards: [] });
    await user.click(screen.getByRole('button', { name: '+ Add card' }));
    await user.type(screen.getByRole('textbox', { name: 'Card title' }), 'a{Shift>}{Enter}{/Shift}b');
    expect(client.createCard).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Card title' })).toHaveValue('a\nb');
  });

  it('renames the column from its heading, and Escape cancels', async () => {
    const user = userEvent.setup();
    const { client } = setup();
    await user.click(screen.getByRole('heading', { name: 'To do' }));
    const input = screen.getByRole('textbox', { name: 'Column name' });
    await user.clear(input);
    await user.type(input, 'Backlog{Enter}');
    expect(client.renameColumn).toHaveBeenCalledWith(COL_TODO, 'Backlog');

    await user.click(screen.getByRole('heading', { name: 'To do' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Column name' })).not.toBeInTheDocument();
    expect(client.renameColumn).toHaveBeenCalledTimes(1);
  });

  it('asks before deleting a column, counting every card, and does nothing if declined', async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { client } = setup();
    const del = screen.getByRole('button', { name: 'Delete column To do' });
    await user.click(del);
    expect(confirm).toHaveBeenCalledWith('Delete "To do" and its 2 card(s)?');
    expect(client.deleteColumn).not.toHaveBeenCalled();
    await user.click(del);
    expect(client.deleteColumn).toHaveBeenCalledWith(COL_TODO);
  });

  it('shows matches out of the total while searching, and locks dragging', () => {
    setup({ filter: (c) => c.title === 'Card 2' });
    expect(screen.getAllByTestId('card')).toHaveLength(1);
    expect(screen.getByRole('img', { name: '1 of 2 cards match' })).toHaveTextContent('1/2');
    expect(screen.getByTestId('card')).toHaveAttribute('draggable', 'false');
  });

  it('counts every card, not just the matching ones, when asking before deleting a filtered column', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    setup({ filter: (c) => c.title === 'Card 2' });
    await userEvent.click(screen.getByRole('button', { name: 'Delete column To do' }));
    expect(confirm).toHaveBeenCalledWith('Delete "To do" and its 2 card(s)?');
  });

  it('gives a viewer the cards without any way to change the column', () => {
    setup({ readOnly: true });
    expect(screen.getAllByTestId('card')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: '+ Add card' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete column/ })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'To do' })).not.toHaveAttribute('title');
  });
});
