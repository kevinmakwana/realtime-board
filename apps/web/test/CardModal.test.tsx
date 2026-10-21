import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Card, Comment, Member } from '@board/shared';
import { CardModal } from '../src/components/CardModal';
import { ada, ADA, fakeClient, grace, GRACE, makeCard, makeComment, makeState } from './componentHelpers';

interface Opts {
  card?: Card;
  comments?: Comment[];
  members?: Member[];
  readOnly?: boolean;
  isOwner?: boolean;
  editors?: { name: string; color: string }[];
}

function setup(opts: Opts = {}) {
  const card = opts.card ?? makeCard(1, { title: 'Ship it', description: 'Soon' });
  const client = fakeClient();
  const onClose = vi.fn();
  const element = (c: Card) => (
    <CardModal
      card={c}
      state={makeState([c], opts.comments ?? [])}
      client={client}
      editors={opts.editors ?? []}
      members={opts.members ?? [ada, grace]}
      readOnly={opts.readOnly ?? false}
      selfUserId={ADA}
      isOwner={opts.isOwner ?? false}
      onClose={onClose}
    />
  );
  const view = render(element(card));
  return { client, onClose, unmount: view.unmount, rerender: (c: Card) => view.rerender(element(c)) };
}

describe('CardModal', () => {
  it('is a labelled dialog that names the column', () => {
    setup();
    const dialog = screen.getByRole('dialog', { name: 'Card details' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(within(dialog).getByText('in To do')).toBeInTheDocument();
  });

  describe('title and description', () => {
    it('saves a changed title when the field loses focus, and tells others it is being edited meanwhile', async () => {
      const user = userEvent.setup();
      const { client } = setup();
      const title = screen.getByLabelText('Title');
      await user.click(title);
      expect(client.setEditing).toHaveBeenLastCalledWith(makeCard(1).id);
      await user.clear(title);
      await user.type(title, 'Ship it today');
      await user.tab();
      expect(client.updateCard).toHaveBeenCalledWith(makeCard(1).id, { title: 'Ship it today' });
      expect(client.setEditing).toHaveBeenCalledWith(null);
    });

    it('does not save when nothing changed, or when the title is emptied', async () => {
      const user = userEvent.setup();
      const { client } = setup();
      await user.click(screen.getByLabelText('Title'));
      await user.tab();
      await user.clear(screen.getByLabelText('Title'));
      await user.tab();
      expect(client.updateCard).not.toHaveBeenCalled();
    });

    it('saves a changed description and Done saves anything still unsaved before closing', async () => {
      const user = userEvent.setup();
      const { client, onClose } = setup();
      await user.type(screen.getByLabelText('Description'), ' and more');
      await user.click(screen.getByRole('button', { name: 'Done' }));
      expect(client.updateCard).toHaveBeenCalledWith(makeCard(1).id, { description: 'Soon and more' });
      expect(onClose).toHaveBeenCalled();
    });

    it('warns only when someone else changed the text being edited, and can load their version', async () => {
      const user = userEvent.setup();
      const { rerender } = setup();
      await user.type(screen.getByLabelText('Description'), ' (my edit)');

      // Someone changes only the due date: our own kind of save, not a conflict.
      rerender(makeCard(1, { title: 'Ship it', description: 'Soon', version: 2, dueDate: '2026-12-01' }));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();

      rerender(makeCard(1, { title: 'Ship it', description: 'Their text', version: 3 }));
      expect(screen.getByRole('alert')).toHaveTextContent('Someone saved changes to this card');
      await user.click(screen.getByRole('button', { name: 'Load their version' }));
      expect(screen.getByLabelText('Description')).toHaveValue('Their text');
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('lists who else is editing', () => {
      setup({ editors: [{ name: 'Grace Hopper', color: '#e5484d' }] });
      expect(screen.getByRole('status')).toHaveTextContent('Grace Hopper is editing this card too');
    });
  });

  describe('due date', () => {
    it('saves a complete date but not a half-typed one', () => {
      const { client } = setup();
      const input = screen.getByLabelText('Due date');
      fireChange(input, '0002-03-01'); // the browser reports partial years like this
      fireChange(input, '');
      expect(client.updateCard).not.toHaveBeenCalled();
      fireChange(input, '2026-12-31');
      expect(client.updateCard).toHaveBeenCalledWith(makeCard(1).id, { dueDate: '2026-12-31' });
    });

    it('clears the date with the button, which only appears when there is one', async () => {
      const user = userEvent.setup();
      const first = setup();
      expect(screen.queryByRole('button', { name: 'Clear due date' })).not.toBeInTheDocument();
      first.rerender(makeCard(1, { dueDate: '2026-12-31' }));
      await user.click(screen.getByRole('button', { name: 'Clear due date' }));
      expect(first.client.updateCard).toHaveBeenCalledWith(makeCard(1).id, { dueDate: null });
    });
  });

  describe('labels', () => {
    it('adds a label on Enter, trimmed, and ignores a duplicate in any case', async () => {
      const user = userEvent.setup();
      const { client } = setup({ card: makeCard(1, { labels: ['Bug'] }) });
      const input = screen.getByLabelText('Add label');
      await user.type(input, '  urgent {Enter}');
      expect(client.updateCard).toHaveBeenCalledWith(makeCard(1).id, { labels: ['Bug', 'urgent'] });
      await user.type(input, 'bug{Enter}');
      expect(client.updateCard).toHaveBeenCalledTimes(1);
      expect(input).toHaveValue('');
    });

    it('removes a label with its button', async () => {
      const { client } = setup({ card: makeCard(1, { labels: ['bug', 'urgent'] }) });
      await userEvent.click(screen.getByRole('button', { name: 'Remove label bug' }));
      expect(client.updateCard).toHaveBeenCalledWith(makeCard(1).id, { labels: ['urgent'] });
    });

    it('hides the input once the card has five labels', () => {
      setup({ card: makeCard(1, { labels: ['a', 'b', 'c', 'd', 'e'] }) });
      expect(screen.queryByLabelText('Add label')).not.toBeInTheDocument();
    });
  });

  describe('assignees', () => {
    it('ticks the current assignees and toggles one on and off', async () => {
      const user = userEvent.setup();
      const { client } = setup({ card: makeCard(1, { assigneeIds: [ADA] }) });
      expect(screen.getByRole('checkbox', { name: 'Ada Lovelace' })).toBeChecked();
      await user.click(screen.getByRole('checkbox', { name: 'Grace Hopper' }));
      expect(client.updateCard).toHaveBeenLastCalledWith(makeCard(1).id, { assigneeIds: [ADA, GRACE] });
      await user.click(screen.getByRole('checkbox', { name: 'Ada Lovelace' }));
      expect(client.updateCard).toHaveBeenLastCalledWith(makeCard(1).id, { assigneeIds: [] });
    });

    it('drops people who have left the board when the assignees change', async () => {
      const gone = '00000000-0000-4000-8000-0000000000ff';
      const { client } = setup({ card: makeCard(1, { assigneeIds: [gone] }), members: [ada, grace] });
      await userEvent.click(screen.getByRole('checkbox', { name: 'Grace Hopper' }));
      expect(client.updateCard).toHaveBeenCalledWith(makeCard(1).id, { assigneeIds: [GRACE] });
    });
  });

  describe('comments', () => {
    it('posts a comment on submit and clears the box', async () => {
      const user = userEvent.setup();
      const { client } = setup();
      expect(screen.getByText('No comments yet.')).toBeInTheDocument();
      await user.type(screen.getByLabelText('Write a comment'), 'Looks good{Enter}');
      expect(client.addComment).toHaveBeenCalledWith(makeCard(1).id, 'Looks good');
      expect(screen.getByLabelText('Write a comment')).toHaveValue('');
    });

    it('lets me edit and delete my own comment but not edit someone else’s', () => {
      const mine = makeComment(1, makeCard(1).id);
      const theirs = makeComment(2, makeCard(1).id, { authorId: GRACE, authorName: 'Grace Hopper' });
      setup({ comments: [mine, theirs] });
      const [first, second] = screen.getAllByTestId('comment');
      expect(within(first!).getByRole('button', { name: /edit/i })).toBeInTheDocument();
      expect(within(first!).getByRole('button', { name: /delete/i })).toBeInTheDocument();
      expect(within(second!).queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
      expect(within(second!).queryByRole('button', { name: /delete/i })).not.toBeInTheDocument();
    });

    it('lets the board owner delete anyone’s comment', () => {
      const theirs = makeComment(2, makeCard(1).id, { authorId: GRACE, authorName: 'Grace Hopper' });
      setup({ comments: [theirs], isOwner: true });
      const item = screen.getByTestId('comment');
      expect(within(item).getByRole('button', { name: /delete/i })).toBeInTheDocument();
      expect(within(item).queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    });
  });

  describe('closing and deleting', () => {
    it('closes with ×, and deletes the card and closes', async () => {
      const user = userEvent.setup();
      const { client, onClose } = setup();
      await user.click(screen.getByRole('button', { name: 'Close' }));
      expect(onClose).toHaveBeenCalledTimes(1);
      await user.click(screen.getByRole('button', { name: 'Delete card' }));
      expect(client.deleteCard).toHaveBeenCalledWith(makeCard(1).id);
      expect(onClose).toHaveBeenCalledTimes(2);
    });

    it('closes when the backdrop is pressed but not when the dialog itself is', async () => {
      const user = userEvent.setup();
      const { onClose } = setup();
      await user.click(screen.getByRole('dialog'));
      expect(onClose).not.toHaveBeenCalled();
      await user.click(screen.getByRole('dialog').parentElement!);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('stops announcing that I am editing when it closes', () => {
      const { client, unmount } = setup();
      client.setEditing.mockClear();
      unmount();
      expect(client.setEditing).toHaveBeenCalledWith(null);
    });
  });

  describe('as a viewer', () => {
    it('shows everything but allows no changes', () => {
      const card = makeCard(1, { title: 'Ship it', labels: ['bug'], dueDate: '2026-12-31', assigneeIds: [ADA] });
      const { client } = setup({ card, readOnly: true, comments: [makeComment(1, card.id)] });
      expect(screen.getByLabelText('Title')).toHaveAttribute('readonly');
      expect(screen.getByLabelText('Description')).toHaveAttribute('readonly');
      expect(screen.getByLabelText('Due date')).toBeDisabled();
      expect(screen.getByRole('checkbox', { name: 'Ada Lovelace' })).toBeDisabled();
      expect(screen.queryByLabelText('Add label')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Remove label bug' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Clear due date' })).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Write a comment')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Delete card' })).not.toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Close' })).toHaveLength(2); // the × and the footer button
      expect(client.updateCard).not.toHaveBeenCalled();
    });
  });
});

function fireChange(input: HTMLElement, value: string) {
  fireEvent.change(input, { target: { value } });
}
