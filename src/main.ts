import { assertProviderAllowed } from './auth/otp.js';
import { buildApp } from './app.js';
import { closePool } from './db/index.js';
import { closeRedis } from './redis/index.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { DependencyError, preflight } from './preflight.js';
import { migrate } from './db/migrate.js';
import { setUpdateHook, startBridge, stopBridge } from './mqtt/bridge.js';
import { onDeviceUpdate, startScheduler, stopScheduler } from './automation/engine.js';
import { startRetentionJob, stopRetentionJob } from './services/retention.js';

async function main(): Promise<void> {
  // Migrate before listening: an instance that serves traffic against a stale
  // schema fails in ways that are much harder to diagnose than a failed boot.
  // Fails fast rather than silently running an auth flow that authenticates
  // nobody in production.
  assertProviderAllowed();

  // Fail with an actionable message rather than a driver stack trace.
  await preflight();

  await migrate();

  const app = await buildApp();

  // Automations run here, in the backend, so they keep working with the app
  // closed. Register before the bridge connects so no update is missed.
  setUpdateHook(onDeviceUpdate);
  await startBridge();
  startScheduler();
  startRetentionJob();

  await app.listen({ port: config.PORT, host: config.HOST });
  logger.info(
    { port: config.PORT, env: config.NODE_ENV, mqtt: config.MQTT_ENABLED },
    'lumen-iot-backend listening',
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');

    // Stop accepting work, then drain, then release connections.
    const timeout = setTimeout(() => {
      logger.error('graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, 15_000);
    timeout.unref();

    try {
      stopRetentionJob();
      stopScheduler();
      setUpdateHook(null);
      await app.close();
      await stopBridge();
      await closeRedis();
      await closePool();
      logger.info('shutdown complete');
      process.exit(0);
    } catch (error) {
      logger.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) =>
    logger.error({ err: reason }, 'unhandled promise rejection'),
  );
}

main().catch((error) => {
  if (error instanceof DependencyError) {
    // No stack trace: the message is the whole point, and a trace buries it.
    // Drop the clients first so their retry logging cannot scroll it away.
    void closeRedis()
      .catch(() => {})
      .finally(() => {
        process.stderr.write(`\n${error.message}\n\n`);
        process.exit(1);
      });
    return;
  }
  logger.error({ err: error }, 'failed to start');
  process.exit(1);
});
