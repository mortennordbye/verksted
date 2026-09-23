/**
 * What the backend's modules log through: Fastify's logger in production, a
 * stub in tests. One declaration rather than one per module (R-34); a module
 * that only warns takes `Pick<Logger, "warn">`, so a test can hand it less.
 */
export interface Logger {
  info: (msg: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}
