import { useSyncExternalStore } from 'react';

const EVENT = 'app:navigate';

export function navigate(path: string): void {
  if (location.pathname + location.search === path) return;
  history.pushState(null, '', path);
  window.dispatchEvent(new Event(EVENT));
}

const subscribe = (fn: () => void) => {
  window.addEventListener('popstate', fn);
  window.addEventListener(EVENT, fn);
  return () => {
    window.removeEventListener('popstate', fn);
    window.removeEventListener(EVENT, fn);
  };
};

export const usePath = (): string => useSyncExternalStore(subscribe, () => location.pathname);
