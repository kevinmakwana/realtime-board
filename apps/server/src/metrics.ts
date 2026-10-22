import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';

export interface Metrics {
  registry: Registry;
  observeRequest(method: string, route: string, status: number, seconds: number): void;
  observeCommand(command: string, result: string, seconds: number): void;
  /** Tell the ws_connections gauge where to read the live socket count from. */
  trackSockets(count: () => number): void;
  /** A retention pass finished and removed this many events. */
  observeRetention(pruned: number): void;
}

/** One registry per server instance, so several instances in a process (tests) never share counters. */
export function createMetrics(instance: string): Metrics {
  const registry = new Registry();
  registry.setDefaultLabels({ instance });
  collectDefaultMetrics({ register: registry });

  const httpRequests = new Counter({
    name: 'http_requests_total',
    help: 'HTTP requests handled, by method, route pattern and status',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });
  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route'],
    registers: [registry],
  });
  const commands = new Counter({
    name: 'board_commands_total',
    help: 'Socket commands handled, by command and outcome (ok or the error code)',
    labelNames: ['command', 'result'],
    registers: [registry],
  });
  const commandDuration = new Histogram({
    name: 'board_command_duration_seconds',
    help: 'Socket command duration in seconds, including the database transaction',
    labelNames: ['command'],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });
  const pruned = new Counter({
    name: 'board_events_pruned_total',
    help: 'Board events deleted by the retention job',
    registers: [registry],
  });
  let socketCount = () => 0;
  new Gauge({
    name: 'ws_connections',
    help: 'Currently connected Socket.IO clients on this instance',
    registers: [registry],
    collect() {
      this.set(socketCount());
    },
  });

  return {
    registry,
    observeRequest(method, route, status, seconds) {
      httpRequests.inc({ method, route, status: String(status) });
      httpDuration.observe({ method, route }, seconds);
    },
    observeCommand(command, result, seconds) {
      commands.inc({ command, result });
      commandDuration.observe({ command }, seconds);
    },
    trackSockets(count) {
      socketCount = count;
    },
    observeRetention(n) {
      pruned.inc(n);
    },
  };
}
