/**
 * Pino-based structured logger with credential redaction.
 *
 * The redact list covers every path that might contain a bearer token or
 * API key. Pino's `redact` option censors at serialization time, so a
 * `logger.info({ req: { headers: { authorization } } })` log line is safe
 * to ship to Loki or similar without scrubbing.
 */

import pino, { type Logger } from 'pino'

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'res.headers["x-api-key"]',
  'apiKey',
  '*.apiKey',
  'apiKeyEnv',
  '*.apiKeyEnv',
  'bearer',
  '*.bearer',
]

export const logger: Logger = pino({
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  level: process.env.DSH_LMSTUDIO_LOG_LEVEL ?? 'info',
  name: 'dsh-lmstudio-pro',
})