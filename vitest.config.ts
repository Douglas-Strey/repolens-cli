import { defineConfig } from 'vitest/config'

// Coverage instrumentation slows code down several times; widen the timing budgets of
// "must not blow up" tests accordingly (see timeBudget in test/helpers.ts).
const coverage = process.argv.includes('--coverage')

export default defineConfig({
  test: {
    env: coverage ? { REPOLENS_TIME_SCALE: '10' } : {},
    include: ['test/**/*.test.ts'],
    exclude: ['test/fixtures/**', 'node_modules/**', 'dist/**'],
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/cli.ts'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
})
