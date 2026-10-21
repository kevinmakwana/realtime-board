import { useEffect, useRef } from 'react';

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard behaviour a modal dialog owes its users: focus moves into it when it opens, Tab stays inside it, and
 * focus goes back to what opened it when it closes. Attach the returned ref to the element with role="dialog".
 */
export function useDialogFocus<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The dialog itself, not its first field: focusing a field can announce "editing" to the other people on the board.
    dialog.focus();

    const trap = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener('keydown', trap);

    return () => {
      dialog.removeEventListener('keydown', trap);
      // The opener may have been re-created since (a card that moved column), so look it up again by its marker.
      const id = opener?.dataset.cardId;
      const target = opener?.isConnected
        ? opener
        : id
          ? document.querySelector<HTMLElement>(`[data-card-id="${id}"]`)
          : null;
      target?.focus();
    };
  }, []);

  return ref;
}
