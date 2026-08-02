import { defineConfig } from 'vitest/config';
import { sharedContractAlias } from './tooling/aliases';

export default defineConfig({
  resolve: { alias: sharedContractAlias },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tooling/**/*.test.ts'],
  },
});
