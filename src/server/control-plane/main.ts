import { createControlPlane } from './service.js';
import { controlPlaneOptionsFromEnvironment } from './main-config.js';

const service = await createControlPlane(controlPlaneOptionsFromEnvironment(process.env));

const address = await service.start();
process.stdout.write(`Steward control plane listening at ${address.url}\n`);

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  process.stdout.write(`Steward control plane draining after ${signal}\n`);
  await service.close();
}

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));
