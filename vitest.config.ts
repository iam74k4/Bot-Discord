import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['src/__tests__/helpers/vitest-env.ts'],
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        // Test support code anywhere (src/__tests__/helpers, feature
        // *.helpers.ts): scaffolding is not what the floors measure.
        'src/**/__tests__/**',
        'src/shared/types/**',
        'src/index.ts',
        'src/client.ts',
        'src/handlers/**', // Command/event loader bootstrap
        'src/app-scripts/**', // CLI maintenance scripts
        'src/events/**', // Discord event handlers (integration)
      ],
      // Floors sit a little under the measured coverage (lines 98.4,
      // functions 97.2, branches 93.9, statements 97.6) so CI fails when a
      // change lands without tests, not on rounding noise.
      thresholds: {
        lines: 97,
        functions: 96,
        branches: 93,
        statements: 96,
      },
    },
  },
});
