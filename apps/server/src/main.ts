import { composeOss } from '@gatemind/composition';
import { createEnvFileSecretStore, loadConfigOrExit } from '@gatemind/config';
import { startServer } from './server';
import { describeStartupError } from './startup-error';

/**
 * Process entrypoint of the Open Source edition (ARC-050, FR-1, FR-19).
 * 1. Validate the configuration: print every problem once and exit 1 (Story 1.2).
 * 2. Compose the runtime: missing settings and unsafe stores stop the start (Story 1.6a).
 * 3. Serve `/livez`, `/readyz` and `/healthz`, and shut down cleanly on SIGTERM or SIGINT.
 */
async function main(): Promise<void> {
  const secretStore = createEnvFileSecretStore({ env: process.env });
  const config = await loadConfigOrExit({ env: process.env, secretStore });
  const say = (message: string): void => void process.stderr.write(`${message}\n`);

  let runtime: Awaited<ReturnType<typeof composeOss>>;
  try {
    runtime = await composeOss({ secretStore });
  } catch (error) {
    say(`Gatemind cannot start. ${describeStartupError(error)}`);
    process.exit(1);
  }

  let running: Awaited<ReturnType<typeof startServer>>;
  try {
    running = await startServer({
      runtime,
      port: config.httpPort,
      shutdownGraceMs: config.shutdownGraceMs,
      exit: (code) => process.exit(code),
      log: say,
    });
  } catch (error) {
    await runtime.close();
    say(`Gatemind cannot start. ${describeStartupError(error)}`);
    process.exit(1);
  }

  running.shutdown.install();
  say(`Gatemind is listening on port ${running.port}.`);
}

void main();
