// Minimal structured logger (one JSON line per event). Callers must never
// pass passwords, tokens or other secrets as fields.
type LogFields = Record<string, string | number | boolean | null | undefined>;

export const logger = {
  info(event: string, fields: LogFields = {}) {
    console.info(JSON.stringify({ level: 'info', time: new Date().toISOString(), event, ...fields }));
  },
};
