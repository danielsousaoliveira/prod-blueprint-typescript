import type { Options } from 'pino-http';
import type { Env } from './env';

export function httpLoggerOptions(env: Pick<Env, 'LOG_LEVEL' | 'NODE_ENV'>): Options {
  return {
    level: env.LOG_LEVEL,
    // JSON in production; an absent transport preserves exactOptionalPropertyTypes.
    ...(env.NODE_ENV === 'development'
      ? { transport: { target: 'pino-pretty', options: { singleLine: true } } }
      : {}),
    autoLogging: {
      ignore: (req) => req.url?.startsWith('/health') ?? false,
    },
    // Responses contain freshly issued bearer credentials, as well as requests.
    redact: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
    ],
  };
}
