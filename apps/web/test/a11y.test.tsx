import axe from 'axe-core';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../src/api';
import { BoardView } from '../src/components/BoardView';
import { CardModal } from '../src/components/CardModal';
import { ShareDialog } from '../src/components/ShareDialog';
import type { BoardViewModel } from '../src/lib/boardClient';
import { ada, ADA, fakeClient, grace, GRACE, makeCard, makeComment, makeState } from './componentHelpers';

vi.mock('../src/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/api')>()),
  api: { listMembers: vi.fn(), activity: vi.fn() },
}));

// axe-core's static rules: names, roles, labels, ARIA validity, landmarks. (Colour contrast needs a real browser.)
async function violations(container: HTMLElement) {
  const result = await axe.run(container, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
  });
  return result.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(' | ')})`);
}

const session = { token: 't', user: { id: ADA, name: 'Ada Lovelace', color: '#0091ff' } };
const cards = [
  makeCard(1, {
    title: 'Fix login',
    labels: ['bug'],
    dueDate: '2026-12-01',
    assigneeIds: [GRACE],
    description: 'Details',
  }),
  makeCard(2, { title: 'Write notes' }),
];
const state = makeState(cards, [makeComment(1, cards[0]!.id)]);

beforeEach(() => {
  vi.mocked(api.listMembers).mockResolvedValue({ members: [ada, grace] });
  vi.mocked(api.activity).mockResolvedValue({ entries: [] });
});

describe('accessibility (axe-core)', () => {
  for (const role of ['owner', 'viewer'] as const) {
    it(`has no violations on the board as ${role}`, async () => {
      const vm: BoardViewModel = {
        status: 'live',
        instance: 'a',
        state,
        presence: [],
        cursors: [],
        selfSocketId: 's',
        role,
      };
      const { container } = render(<BoardView client={fakeClient()} vm={vm} state={state} session={session} />);
      expect(await violations(container)).toEqual([]);
    });
  }

  for (const readOnly of [false, true]) {
    it(`has no violations in the card dialog${readOnly ? ' for a viewer' : ''}`, async () => {
      const { baseElement } = render(
        <CardModal
          card={cards[0]!}
          state={state}
          client={fakeClient()}
          editors={[]}
          members={[ada, grace]}
          readOnly={readOnly}
          selfUserId={ADA}
          isOwner
          onClose={vi.fn()}
        />,
      );
      expect(await violations(baseElement)).toEqual([]);
    });
  }

  it('has no violations in the share dialog', async () => {
    const { baseElement, findByText } = render(
      // biome-ignore lint/a11y/useValidAriaRole: `role` here is the user's board role (a prop), not an ARIA role
      <ShareDialog boardId={state.board.id} role="owner" selfUserId={ADA} onClose={vi.fn()} />,
    );
    await findByText(/Ada Lovelace/);
    expect(await violations(baseElement)).toEqual([]);
  });
});
