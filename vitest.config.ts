import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/components/**/*.test.tsx', 'tests/lib/**/*.test.tsx', 'tests/lib/**/*.test.ts'],
    exclude: ['node_modules', '.next', 'backend'],
    coverage: {
      provider: 'v8',
      include: [
        'components/**/*.{ts,tsx}',
        'lib/**/*.{ts,tsx}',
        'app/**/*.{ts,tsx}',
      ],
      exclude: [
        '**/*.d.ts',
        '**/*.config.*',
        '**/node_modules/**',
        '**/.next/**',
      ],
    },
    deps: {
      interopDefault: true,
    },
  },
  // oxc.jsx must be an OBJECT here (rolldown-vite spreads config.oxc
  // straight into the native transform binding, which rejects esbuild-style
  // strings like 'automatic' with [BUNDLER_INITIALIZE_ERROR]
  // "Invalid jsx option"). runtime:'automatic' = React 17+ JSX transform.
  oxc: {
    jsx: { runtime: 'automatic' },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
})
