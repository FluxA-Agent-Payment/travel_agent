import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['lib/__tests__/**/*.test.ts'],
    // Each test file gets a clean module graph so sharedMap tests are isolated.
    isolate: true,
  },
  resolve: {
    alias: {
      '@': import.meta.dirname ?? '.',
    },
  },
});
