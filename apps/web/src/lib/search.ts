import { selectComments, type BoardState, type Card } from '@board/shared';

/** A query is a list of lowercase words; a card matches when every word appears somewhere on it. */
export function parseQuery(raw: string): string[] {
  return raw.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Title, description, labels, assignee names and comment text, all case-insensitive. */
export function cardMatches(
  state: BoardState,
  card: Card,
  words: string[],
  memberNames: ReadonlyMap<string, string>,
): boolean {
  if (words.length === 0) return true;
  const haystack = [
    card.title,
    card.description,
    ...card.labels,
    ...card.assigneeIds.map((id) => memberNames.get(id) ?? ''),
    ...selectComments(state, card.id).map((c) => c.body),
  ]
    .join('\n')
    .toLowerCase();
  return words.every((w) => haystack.includes(w));
}
