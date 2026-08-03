import { z } from 'zod';

/**
 * Every environment variable is read and validated here and nowhere else, so a
 * misconfigured deployment fails at boot with a readable message instead of at
 * the first request that happens to touch the missing value.
 */

const booleanish = z
  .string()
  .transform((value) => ['1', 'true', 'yes', 'on'].includes(value.toLowerCase()));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  LOG_PRETTY: booleanish.default('false'),
  CORS_ORIGINS: z.string().default('*'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PG_POOL_MAX: z.coerce.number().int().positive().default(10),

  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),
  REQUIRE_EMAIL_VERIFICATION: booleanish.default('true'),

  // ── OTP login ──────────────────────────────────────────────────
  // 'static' accepts one fixed code for every number — development only.
  // 'sms' generates a real random code and calls the gateway.
  OTP_PROVIDER: z.enum(['static', 'sms']).default('static'),
  OTP_STATIC_CODE: z.string().regex(/^\d{4,8}$/).default('111111'),
  OTP_CODE_LENGTH: z.coerce.number().int().min(4).max(8).default(6),
  OTP_TTL_SECONDS: z.coerce.number().int().positive().max(3600).default(300),
  OTP_MAX_ATTEMPTS: z.coerce.number().int().positive().max(10).default(5),
  OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().min(0).max(600).default(30),
  OTP_MAX_REQUESTS_PER_HOUR: z.coerce.number().int().positive().default(10),
  OTP_ALLOW_INSECURE_IN_PRODUCTION: booleanish.default('false'),

  MAIL_TRANSPORT: z.enum(['console', 'noop']).default('console'),
  MAIL_FROM: z.string().default('no-reply@localhost'),
  PUBLIC_APP_URL: z.string().default('http://localhost:4000'),

  MQTT_ENABLED: booleanish.default('true'),
  MQTT_URL: z.string().default('mqtts://lumeniot.sahajarya.com:8883'),
  MQTT_USERNAME: z.string().default(''),
  MQTT_PASSWORD: z.string().default(''),
  MQTT_CLIENT_ID: z.string().default('lumen-backend'),
  MQTT_BASE_TOPIC: z.string().default('devices'),
  MQTT_CA_FILE: z.string().default(''),

  TELEMETRY_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
  DEVICE_STALE_SECONDS: z.coerce.number().int().positive().default(180),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
});

export type Config = z.infer<typeof schema> & {
  isProduction: boolean;
  corsOrigins: string[] | true;
};

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  const value = parsed.data;

  // A production deployment that still carries the sample secret is a real
  // vulnerability, not a warning — refuse to start.
  if (value.NODE_ENV === 'production' && value.JWT_SECRET.includes('change-me')) {
    throw new Error('JWT_SECRET still holds the example value; generate a real secret');
  }
  if (value.NODE_ENV === 'production' && value.CORS_ORIGINS === '*') {
    throw new Error('CORS_ORIGINS must list explicit origins in production');
  }

  return {
    ...value,
    isProduction: value.NODE_ENV === 'production',
    corsOrigins:
      value.CORS_ORIGINS === '*'
        ? true
        : value.CORS_ORIGINS.split(',')
            .map((origin) => origin.trim())
            .filter(Boolean),
  };
}

export const config = load();
