import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// What the build reads from .env.local. Nothing is sent to these hosts: the tests answer every request.
const env = {
  VITE_API_URL: 'https://api.copilot.test/v1/',
  VITE_CLERK_PUBLISHABLE_KEY: 'pk_test_fake',
  VITE_CLERK_SYNC_HOST: 'https://copilot.test',
  VITE_POSTHOG_HOST: 'https://posthog.test',
  VITE_POSTHOG_KEY: 'phc_test_project_key',
}

// The tests run without the build config (vite.config.ts), which needs the build's env.
export default defineConfig({
  test: {
    projects: [
      // The extension's client code, in Node, with the real modules, on the same clock as the UI tests.
      { test: { name: 'client', include: ['test/**/*.test.ts'], env: { ...env, TZ: 'Asia/Kolkata' } } },
      // The side panel's UI, in a DOM. Only here is Clerk a fake; see test/clerk.tsx.
      {
        resolve: {
          alias: { '@clerk/chrome-extension': fileURLToPath(new URL('./test/clerk.tsx', import.meta.url)) },
        },
        // The panel shows times on the user's own clock and tells the worker how far it is from UTC.
        // The tests pin a clock that is not UTC, and not a whole number of hours from it.
        test: {
          name: 'ui',
          include: ['test/**/*.test.tsx'],
          environment: 'jsdom',
          env: { ...env, TZ: 'Asia/Kolkata' },
        },
      },
    ],
  },
})
