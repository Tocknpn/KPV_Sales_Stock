import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // freshDb() boots PGlite and loads the full schema; slow under parallel load.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
