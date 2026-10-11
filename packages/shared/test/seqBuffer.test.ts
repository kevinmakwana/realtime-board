import { describe, expect, it } from 'vitest';
import { SeqBuffer } from '../src/index.js';
import { card, ev, ids } from './fixtures.js';

const e = (seq: number) => ev(seq, 'card.deleted', { cardId: ids.card1 });
const seqs = (events: { seq: number }[]) => events.map((x) => x.seq);

describe('SeqBuffer ordering', () => {
  it('passes in-order events straight through', () => {
    const b = new SeqBuffer(0);
    expect(seqs(b.offer(e(1)).events)).toEqual([1]);
    expect(seqs(b.offer(e(2)).events)).toEqual([2]);
    expect(b.seq).toBe(2);
  });

  it('holds back out-of-order events and flushes them when the gap fills', () => {
    const b = new SeqBuffer(0);
    const r3 = b.offer(e(3));
    expect(r3).toMatchObject({ events: [], gap: true, from: 0 });
    expect(b.offer(e(2))).toMatchObject({ events: [], gap: true });
    const r1 = b.offer(e(1));
    expect(seqs(r1.events)).toEqual([1, 2, 3]);
    expect(r1.gap).toBe(false);
    expect(b.size).toBe(0);
  });

  it('drops duplicates and stale events', () => {
    const b = new SeqBuffer(5);
    expect(b.offer(e(5)).events).toEqual([]);
    expect(b.offer(e(3)).events).toEqual([]);
    expect(seqs(b.offer(e(6)).events)).toEqual([6]);
    expect(b.offer(e(6)).events).toEqual([]);
  });

  it('reports a persistent gap so the caller can request catch-up', () => {
    const b = new SeqBuffer(10);
    const r = b.offer(ev(14, 'card.created', { card: card(ids.card1, ids.colA, 'a0') }));
    expect(r).toMatchObject({ gap: true, from: 10 });
  });

  it('offerMany applies a replay batch in order regardless of arrival order', () => {
    const b = new SeqBuffer(0);
    const r = b.offerMany([e(2), e(1), e(3)]);
    expect(seqs(r.events)).toEqual([1, 2, 3]);
    expect(r.gap).toBe(false);
  });

  it('reset after a snapshot discards obsolete buffered events', () => {
    const b = new SeqBuffer(0);
    b.offer(e(3));
    b.offer(e(9));
    b.reset(5);
    expect(b.seq).toBe(5);
    expect(b.size).toBe(1);
    expect(seqs(b.offerMany([e(6), e(7), e(8)]).events)).toEqual([6, 7, 8, 9]);
  });
});
