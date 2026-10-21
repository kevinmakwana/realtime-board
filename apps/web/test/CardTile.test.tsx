import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CardTile } from '../src/components/CardTile';
import { localToday } from '../src/lib/cardMeta';
import { ada, ADA, grace, GRACE, makeCard } from './componentHelpers';

const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return localToday(d);
};

function setup(card = makeCard(1), over: Partial<Parameters<typeof CardTile>[0]> = {}) {
  const props = {
    card,
    dragging: false,
    readOnly: false,
    commentCount: 0,
    editors: [],
    members: new Map([
      [ADA, ada],
      [GRACE, grace],
    ]),
    onOpen: vi.fn(),
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
    ...over,
  };
  render(<CardTile {...props} />);
  return props;
}

describe('CardTile', () => {
  it('shows only the title for a plain card', () => {
    setup();
    expect(screen.getByText('Card 1')).toBeInTheDocument();
    expect(screen.queryByTestId('due')).not.toBeInTheDocument();
    expect(screen.queryByTestId('label')).not.toBeInTheDocument();
    expect(screen.queryByText(/comment/)).not.toBeInTheDocument();
  });

  it('shows labels, comment count (singular and plural) and a description marker', () => {
    setup(makeCard(1, { labels: ['bug', 'urgent'], description: 'More detail' }), { commentCount: 1 });
    expect(screen.getAllByTestId('label').map((l) => l.textContent)).toEqual(['bug', 'urgent']);
    expect(screen.getByText('1 comment')).toBeInTheDocument();
    expect(screen.getByTitle('Has a description')).toBeInTheDocument();
  });

  it('pluralises the comment count', () => {
    setup(makeCard(1), { commentCount: 3 });
    expect(screen.getByText('3 comments')).toBeInTheDocument();
  });

  it.each([
    [-2, 'overdue'],
    [0, 'today'],
    [4, 'upcoming'],
  ])('flags a due date %i days away as %s', (offset, status) => {
    setup(makeCard(1, { dueDate: day(offset) }));
    expect(screen.getByTestId('due')).toHaveClass('due', status);
  });

  it('names assignees for screen readers, and falls back for someone who has left the board', () => {
    setup(makeCard(1, { assigneeIds: [GRACE, '00000000-0000-4000-8000-0000000000ff'] }));
    expect(screen.getByText('Grace Hopper', { selector: '.sr-only' })).toBeInTheDocument();
    expect(screen.getByText('Former member', { selector: '.sr-only' })).toBeInTheDocument();
    expect(screen.getAllByTestId('assignee')).toHaveLength(2);
  });

  it('opens on click, and on Enter or Space from the keyboard', async () => {
    const user = userEvent.setup();
    const { onOpen } = setup();
    const tile = screen.getByTestId('card');
    await user.click(tile);
    expect(onOpen).toHaveBeenCalledTimes(1);
    tile.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');
    expect(onOpen).toHaveBeenCalledTimes(3);
  });

  it('is draggable for editors', () => {
    setup();
    expect(screen.getByTestId('card')).toHaveAttribute('draggable', 'true');
  });

  it('is not draggable for a viewer', () => {
    setup(makeCard(1), { readOnly: true });
    expect(screen.getByTestId('card')).toHaveAttribute('draggable', 'false');
  });

  it('says who else is editing it', () => {
    setup(makeCard(1), { editors: [{ name: 'Grace Hopper', color: '#e5484d' }] });
    expect(screen.getByTestId('editing-indicator')).toHaveTextContent('Grace Hopper is editing');
  });
});
