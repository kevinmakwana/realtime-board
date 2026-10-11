import type { PresenceMember } from '@board/shared';

/** One avatar per person (not per tab). */
export function PresenceBar({ members, selfUserId }: { members: PresenceMember[]; selfUserId: string }) {
  const people = new Map<string, PresenceMember['user']>();
  for (const m of members) people.set(m.user.id, m.user);
  const list = [...people.values()];
  return (
    <ul className="presence" aria-label="People on this board" data-testid="presence">
      {list.map((u) => (
        <li
          key={u.id}
          className="avatar"
          style={{ background: u.color }}
          title={u.id === selfUserId ? `${u.name} (you)` : u.name}
          data-testid="presence-avatar"
          data-name={u.name}
        >
          {u.name[0]}
        </li>
      ))}
    </ul>
  );
}
