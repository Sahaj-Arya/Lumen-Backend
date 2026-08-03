import pino from 'pino';

import { config } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  // Anything that could carry a credential or token is stripped before it
  // reaches a log sink.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      '*.password',
      'refreshToken',
      '*.refreshToken',
      'mqttPassword',
      '*.mqttPassword',
    ],
    censor: '[redacted]',
  },
  transport: config.LOG_PRETTY
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
    : undefined,
});
