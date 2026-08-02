import { fileURLToPath } from 'node:url';

/**
 * The browser resolves the shared contract from SOURCE, so Vite can hot-reload
 * it. The Node runtime keeps its own `#shared/*` subpath imports (see the
 * `imports` map in package.json), which point at compiled output under build/
 * because that is what it actually executes. Same contract, two resolutions,
 * for two genuinely different consumers.
 *
 * Declared here because vite.config.ts and vitest.config.ts are independent
 * configs and both need it.
 */
export const sharedContractAlias = {
  '@shared': fileURLToPath(new URL('../src/shared', import.meta.url)),
};
