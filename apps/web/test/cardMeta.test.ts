import { describe, expect, it } from 'vitest';
import { dueStatus, formatDue, labelHue, localToday } from '../src/lib/cardMeta';

describe('cardMeta', () => {
  it('uses the local calendar day for today', () => {
    expect(localToday(new Date(2026, 2, 5, 23, 59))).toBe('2026-03-05');
    expect(localToday(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31');
  });

  it('classifies a due date against today', () => {
    expect(dueStatus('2026-03-04', '2026-03-05')).toBe('overdue');
    expect(dueStatus('2026-03-05', '2026-03-05')).toBe('today');
    expect(dueStatus('2026-03-06', '2026-03-05')).toBe('upcoming');
    expect(dueStatus('2025-12-31', '2026-01-01')).toBe('overdue');
  });

  it('formats a due date, adding the year only when it differs', () => {
    expect(formatDue('2026-03-15', '2026-01-02')).toBe('Mar 15');
    expect(formatDue('2027-01-09', '2026-12-30')).toBe('Jan 9, 2027');
  });

  it('gives a label the same hue every time, regardless of case', () => {
    expect(labelHue('Bug')).toBe(labelHue('bug'));
    expect(labelHue('bug')).toBeGreaterThanOrEqual(0);
    expect(labelHue('bug')).toBeLessThan(360);
    expect(labelHue('bug')).not.toBe(labelHue('urgent'));
  });
});
