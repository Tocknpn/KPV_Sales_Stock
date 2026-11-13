import { defineConfig } from 'vitest/config';

// freshDb() boots PGlite and loads the full schema; that is slow and memory
// heavy, so under full parallel load the first hook can blow the timeout.
// The SQL suites run in their own project with a capped worker pool, while the
// fast API/unit tests keep the default parallelism.
const timeouts = { testTimeout: 30000, hookTimeout: 30000 };

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'sql',
          include: ['test/sql/**/*.test.ts'],
          pool: 'forks',
          poolOptions: { forks: { minForks: 1, maxForks: 3 } },
          ...timeouts,
        },
      },
      {
        test: {
          name: 'unit',
          include: ['**/*.test.{ts,tsx}'],
          exclude: ['**/node_modules/**', '**/dist/**', 'test/sql/**'],
          ...timeouts,
        },
      },
    ],
  },
});
