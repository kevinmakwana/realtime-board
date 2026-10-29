import { describe, expect, it } from 'vitest';
import { transportsFor } from '../src/lib/transport';

describe('socket transports', () => {
  it('keeps long-polling as a fallback by default (needs sticky sessions at the load balancer)', () => {
    expect(transportsFor(undefined)).toBeUndefined(); // socket.io-client default: polling, then upgrade to websocket
    expect(transportsFor('')).toBeUndefined();
    expect(transportsFor('false')).toBeUndefined();
  });

  it('uses WebSocket only when the build asks for it', () => {
    expect(transportsFor('true')).toEqual(['websocket']);
    expect(transportsFor('1')).toEqual(['websocket']);
  });
});
