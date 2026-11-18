import { defineConfig } from 'vitest/config';

// Separate from vite.config.ts, whose root is the browser client.
export default defineConfig({
  root: '.',
  test: { include: ['test/**/*.test.ts'] },
});
