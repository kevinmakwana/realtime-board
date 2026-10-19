import pino from 'pino';

/**
 * Every log call is a message plus optional fields. A `level` field ('error', 'warn', ...) sets the
 * log level; everything else is data. Free text and fields work the same in both output formats.
 */
export type Logger = (message: string, fields?: Record<string, unknown>) => void;
export const noopLogger: Logger = () => {};

export interface LoggerOptions {
  /** `json`: one JSON object per line (for log shippers). `text`: readable lines for a terminal. */
  format: 'json' | 'text';
  instance: string;
  /** Where lines go; defaults to stdout. Each line already ends with a newline. */
  write?: (line: string) => void;
}

export function createLogger({
  format,
  instance,
  write = (line) => void process.stdout.write(line),
}: LoggerOptions): Logger {
  if (format === 'text') {
    return (message, fields) => {
      const { level: _level, ...data } = fields ?? {};
      write(`${message}${Object.keys(data).length ? ` ${JSON.stringify(data)}` : ''}\n`);
    };
  }
  const logger = pino(
    {
      base: { instance },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { level: (label) => ({ level: label }) },
    },
    { write },
  );
  return (message, fields) => {
    const { level = 'info', ...data } = fields ?? {};
    logger[level as 'info' | 'warn' | 'error'](data, message);
  };
}
