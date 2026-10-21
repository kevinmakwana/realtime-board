import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Vitest does not expose globals, so Testing Library cannot register its own cleanup.
afterEach(() => cleanup());

// jsdom has no canvas; axe-core probes for one and jsdom logs "not implemented" each time. Say there is none.
HTMLCanvasElement.prototype.getContext = () => null;
