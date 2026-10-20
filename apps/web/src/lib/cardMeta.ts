export type DueStatus = 'overdue' | 'today' | 'upcoming';

/** Today's date in the viewer's own calendar, as `YYYY-MM-DD`. */
export function localToday(now: Date = new Date()): string {
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${month}-${day}`;
}

/** Due dates are calendar days, so plain string comparison orders them correctly. */
export function dueStatus(dueDate: string, today: string = localToday()): DueStatus {
  if (dueDate < today) return 'overdue';
  return dueDate === today ? 'today' : 'upcoming';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** `2026-03-15` → `Mar 15` (the year is added only when it is not the current one). */
export function formatDue(dueDate: string, today: string = localToday()): string {
  const [year, month, day] = dueDate.split('-').map(Number);
  const text = `${MONTHS[(month ?? 1) - 1]} ${day}`;
  return String(year) === today.slice(0, 4) ? text : `${text}, ${year}`;
}

/** The same label always gets the same colour, so a board's labels are recognisable at a glance. */
export function labelHue(label: string): number {
  let hash = 0;
  for (const ch of label.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)!) % 360;
  return hash;
}
