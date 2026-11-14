// Loads the built extension (extensions/notico/dist) into Chromium and checks that it still works there.
// Nothing leaves the machine: Notion, the other site, and Clerk's Frontend API are answered from
// fixtures/, usage events are taken and dropped, and any other request fails the test. The extension's own code and its bundled
// dependencies run unchanged.
import { chromium, expect, test as base, type BrowserContext, type Request, type Worker } from '@playwright/test'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const DIST = path.resolve(import.meta.dirname, '../../extensions/notico/dist')
const FIXTURES = path.resolve(import.meta.dirname, '../fixtures')

const NOTION_URLS = ['https://www.notion.so/Smoke-Test-Page', 'https://app.notion.com/p/smoke-test-page']
const OTHER_URL = 'https://example.com/'
const PAGE_HOSTS = [...NOTION_URLS, OTHER_URL].map((url) => new URL(url).hostname)

// What Clerk asks its Frontend API for while loading, answered as a signed-out client would be.
const CLERK_FIXTURES: Record<string, string> = {
  '/v1/environment': 'clerk-environment.json',
  '/v1/client': 'clerk-client.json',
}

/**
 * Hosts the built extension may call besides Notion: Clerk's Frontend API and the sign-in page,
 * as its manifest lists them. Clerk's fixtures answer only there, so a request for the same
 * path on any other host is blocked like the rest.
 */
function apiHosts(): string[] {
  const manifest = JSON.parse(readFileSync(path.join(DIST, 'manifest.json'), 'utf8')) as { host_permissions: string[] }
  return manifest.host_permissions
    .map((pattern) => new URL(pattern.replace('*.', '')).hostname)
    .filter((host) => !PAGE_HOSTS.includes(host))
}

function corsHeaders(request: Request): Record<string, string> {
  return {
    'access-control-allow-origin': request.headers().origin ?? '*',
    'access-control-allow-credentials': 'true',
  }
}

interface Fixtures {
  context: BrowserContext
  /** The extension's service worker (background.ts). */
  background: Worker
  /** Requests the fixtures don't answer. They are blocked, and a test expects none. */
  blocked: string[]
  /**
   * What the service worker logged with console.error, which is how background.ts reports
   * failures. Collected by the background fixture, from as early as Playwright sees the worker.
   */
  backgroundErrors: string[]
}

const test = base.extend<Fixtures>({
  // Playwright reads a fixture's dependencies from this destructuring pattern, so it can't be `_`.
  // oxlint-disable-next-line no-empty-pattern
  blocked: async ({}, use) => {
    await use([])
  },
  context: async ({ blocked }, use) => {
    if (!existsSync(path.join(DIST, 'manifest.json'))) {
      throw new Error(`No built extension at ${DIST}. Run pnpm build first.`)
    }
    // Extensions need a persistent context, and Playwright's own Chromium: Chrome and Edge
    // no longer take --load-extension.
    const clerkHosts = apiHosts()
    const context = await chromium.launchPersistentContext('', {
      channel: 'chromium',
      args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`],
    })
    await context.route('**/*', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      if (url.protocol === 'chrome-extension:') return route.continue()
      if (PAGE_HOSTS.includes(url.hostname)) return route.fulfill({ path: path.join(FIXTURES, 'page.html') })
      const clerkFixture =
        request.method() === 'GET' && clerkHosts.includes(url.hostname) ? CLERK_FIXTURES[url.pathname] : undefined
      if (clerkFixture) {
        return route.fulfill({ path: path.join(FIXTURES, clerkFixture), headers: corsHeaders(request) })
      }
      // A usage event (src/analytics.ts), when the build has a PostHog key: taken as PostHog takes
      // it, and sent nowhere. Anything else to PostHog (a script, its configuration) is blocked.
      if (request.method() === 'POST' && url.hostname.endsWith('.i.posthog.com') && url.pathname === '/e/') {
        return route.fulfill({ json: { status: 1 }, headers: corsHeaders(request) })
      }
      blocked.push(`${request.method()} ${request.url()}`)
      return route.abort()
    })
    await use(context)
    await context.close()
  },
  // Playwright reads a fixture's dependencies from this destructuring pattern, so it can't be `_`.
  // oxlint-disable-next-line no-empty-pattern
  backgroundErrors: async ({}, use) => {
    await use([])
  },
  background: async ({ context, backgroundErrors }, use) => {
    const background = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'))
    // Listen from the first moment Playwright has the worker, so failures during start-up are
    // seen too. A message logged before that moment can still be missed; start-up's result is
    // also checked directly (the panel behavior below).
    background.on('console', (message) => {
      if (message.type() === 'error') backgroundErrors.push(message.text())
    })
    // All background.ts does at start-up; wait for it, so a test never looks before it ran.
    await expect
      .poll(() => background.evaluate(() => chrome.sidePanel.getPanelBehavior()))
      .toEqual({ openPanelOnActionClick: true })
    await use(background)
  },
})

/** The side panel options of the tab showing `url`. */
function panelOptions(background: Worker, url: string): Promise<chrome.sidePanel.PanelOptions | undefined> {
  return background.evaluate(async (tabUrl) => {
    const tabs = await chrome.tabs.query({})
    const tab = tabs.find((candidate) => candidate.url === tabUrl)
    return tab?.id === undefined ? undefined : chrome.sidePanel.getOptions({ tabId: tab.id })
  }, url)
}

test('the service worker starts and sets up the side panel', async ({ background, backgroundErrors, blocked }) => {
  // The background fixture has already waited for start-up to finish.
  expect(await background.evaluate(() => chrome.sidePanel.getPanelBehavior())).toEqual({
    openPanelOnActionClick: true,
  })
  expect(backgroundErrors).toEqual([])
  expect(blocked).toEqual([])
})

test('the side panel is enabled on every tab, Notion or not', async ({
  context,
  background,
  backgroundErrors,
  blocked,
}) => {
  for (const url of [...NOTION_URLS, OTHER_URL]) {
    const page = await context.newPage()
    await page.goto(url)
    await expect.poll(() => panelOptions(background, url), url).toMatchObject({ enabled: true, path: 'sidepanel.html' })
  }

  // Leaving Notion in the same tab keeps the panel.
  const notionPage = context.pages().find((candidate) => candidate.url() === NOTION_URLS[0])!
  await notionPage.goto(`${OTHER_URL}next`)
  await expect
    .poll(() => panelOptions(background, `${OTHER_URL}next`))
    .toMatchObject({ enabled: true, path: 'sidepanel.html' })
  expect(backgroundErrors).toEqual([])
  expect(blocked).toEqual([])
})

test('the side panel page shows the signed-out state', async ({ context, background, blocked }) => {
  const errors: string[] = []
  const clerkRequests: string[] = []
  const page = await context.newPage()
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`)
  })
  page.on('requestfinished', (request) => {
    const { pathname } = new URL(request.url())
    if (pathname in CLERK_FIXTURES) clerkRequests.push(pathname)
  })

  await page.goto(`chrome-extension://${new URL(background.url()).host}/sidepanel.html`)

  await expect(page.getByText('Sign in to use Notico.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  // The button alone proves little: it also shows when Clerk fails to load. So check that Clerk
  // itself is ready, with the signed-out client from the fixture, after asking only once.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const clerk = (window as { Clerk?: { status?: string; user?: unknown; client?: { id?: string } } }).Clerk
        return { status: clerk?.status, user: clerk?.user, client: clerk?.client?.id }
      }),
    )
    .toEqual({ status: 'ready', user: null, client: 'client_smoke' })
  expect(clerkRequests.toSorted()).toEqual(Object.keys(CLERK_FIXTURES).toSorted())
  expect(errors).toEqual([])
  expect(blocked).toEqual([])
})
