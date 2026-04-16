import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    exclude: [
      'dist/**',
      'node_modules/**',
      '.git/**',
      '.opencode/**', // Exclude OpenCode artifacts including third-party test files
    ],
  },
});

