import type { BoardEvent } from './events.js';

export type OfferResult =
  /** Events ready to apply, in order (may be empty). */
  | { events: BoardEvent[]; gap: false }
  /** Something is missing between `lastSeq` and the earliest buffered event. */
  | { events: BoardEvent[]; gap: true; from: number };

/**
 * Re-orders sequenced events. Two instances can publish seq 5 and 6 in the
 * opposite order, and the network can drop events during a reconnect, so the
 * client only applies `lastSeq + 1` and holds anything later until the hole
 * is filled (or a catch-up request fills it).
 */
export class SeqBuffer {
  private pending = new Map<number, BoardEvent>();

  constructor(private lastSeq: number) {}

  get seq(): number {
    return this.lastSeq;
  }

  get size(): number {
    return this.pending.size;
  }

  /** Jump forward after loading a snapshot. Drops anything now obsolete. */
  reset(seq: number): void {
    this.lastSeq = seq;
    for (const s of this.pending.keys()) if (s <= seq) this.pending.delete(s);
  }

  offer(event: BoardEvent): OfferResult {
    if (event.seq > this.lastSeq) this.pending.set(event.seq, event);
    const ready: BoardEvent[] = [];
    for (let next = this.lastSeq + 1; ; next++) {
      const e = this.pending.get(next);
      if (!e) break;
      ready.push(e);
      this.pending.delete(next);
      this.lastSeq = next;
    }
    if (this.pending.size > 0) return { events: ready, gap: true, from: this.lastSeq };
    return { events: ready, gap: false };
  }

  offerMany(events: readonly BoardEvent[]): OfferResult {
    let result: OfferResult = { events: [], gap: false };
    const all: BoardEvent[] = [];
    for (const e of events) {
      result = this.offer(e);
      all.push(...result.events);
    }
    return result.gap ? { events: all, gap: true, from: result.from } : { events: all, gap: false };
  }
}
