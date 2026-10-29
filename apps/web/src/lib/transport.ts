/**
 * Which Socket.IO transports the browser may use. By default the client starts with HTTP long-polling and upgrades
 * to WebSocket, which works through proxies that block WebSockets but needs every request of a session on one server
 * instance (sticky sessions). Building the web app with `VITE_WS_ONLY=true` connects with a WebSocket straight away:
 * no polling fallback, and the load balancer no longer needs to be sticky.
 */
export function transportsFor(wsOnly: string | undefined): ['websocket'] | undefined {
  return wsOnly === 'true' || wsOnly === '1' ? ['websocket'] : undefined;
}
