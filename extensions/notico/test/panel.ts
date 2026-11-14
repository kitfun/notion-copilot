// The side panel's UI tests run the whole panel: the page sidepanel.html loads, with the real agent,
// tools, and session store behind it, and the real worker answering its model calls. Only the edges
// are fakes: chrome.* (with a Notion tab), Clerk (see clerk.tsx), IndexedDB, the model binding, the
// services a user's own model is on (OpenRouter, DeepSeek), and PostHog, where usage events go.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { act } from '@testing-library/react'
import { IDBFactory } from 'fake-indexeddb'
import { vi } from 'vitest'
import { createApp, type Env } from '../../../worker/src/app'
import { FakeClerk } from '../../../worker/test/clerk'
import {
  FakeAiBinding,
  FakeD1Database,
  FakeExecutionContext,
  FakeUsageDataset,
  FakeRateLimiter,
  MODEL,
} from '../../../worker/test/fakes'
import { FakeStripe, signature, WEBHOOK_SECRET } from '../../../worker/test/stripe'
import type { FakeSession } from './clerk'
import { DEEPSEEK, FakeDeepSeek } from './deepseek'
import { restoreGlobals, type FakeNotionTab } from './notion-tab'
import { FakeOpenRouter, OPENROUTER } from './openrouter'
import { FakePostHog, POSTHOG } from './posthog'
import { failingTitles, titleRequests } from './titles'

const EXTENSION = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
/** Where the worker answers (VITE_API_URL in vitest.config.ts): the origin its admin page signs in on. */
const WORKER = 'https://api.copilot.test'
/** When every test starts. Tests move the clock themselves (`vi.setSystemTime`); nothing waits for real time. */
export const START = new Date('2026-11-08T12:00:00Z')

const globals = globalThis as Record<string, unknown>
// jsdom lays nothing out, so it has no scrolling; the panel scrolls its messages to the newest one.
Element.prototype.scrollTo ??= () => {}
const app = createApp()
// One key pair for the whole file: making one takes longer than a test.
let clerk: Promise<FakeClerk> | undefined

/**
 * A browser with the extension installed and one tab: its chrome.* APIs, its IndexedDB, who is
 * signed in to Notico, and the worker the panel talks to. Lives for one test.
 */
export class FakeBrowser {
  /** The model behind the worker; script its replies, and read what it was sent. Title requests go to `titles`. */
  readonly ai = new FakeAiBinding()
  /**
   * The same model, for the panel's title requests (see `titleRequests`), so they never take a reply
   * scripted for a question. Fails until a test gives it a reply: the session keeps its first question.
   */
  readonly titles = failingTitles()
  /** The worker's database: the signed-in user's credits. A test may make it fail. */
  readonly db = new FakeD1Database()
  /** URLs the panel opened in new tabs. */
  readonly openedTabs: string[] = []
  /** Stripe behind the worker: the Checkout Sessions made, and the events it sends about them. */
  readonly stripe = new FakeStripe()
  /** OpenRouter, for a user's own model; script its model, and read what it was sent. */
  readonly openRouter = new FakeOpenRouter()
  /** DeepSeek, for a user's own model; script its model, and read what it was sent. */
  readonly deepSeek = new FakeDeepSeek()
  /** PostHog, where the panel sends usage events; read what it was sent. */
  readonly postHog = new FakePostHog()
  /** Every request the panel sent the worker, as text: its URL, headers, and body. */
  readonly sentToWorker: string[] = []

  /** Asks the worker something outside the panel; set when the browser starts. */
  private worker!: (request: Request) => Response | Promise<Response>
  /** The worker's configuration; a test may change it, such as taking buying credits away. */
  env!: Env
  private issuer!: FakeClerk

  private constructor(
    readonly tab: FakeNotionTab,
    private readonly session: FakeSession | undefined,
  ) {}

  /**
   * An operator grants `userId` credits by hand, for `days` days: on the worker's admin route, as
   * the admin page does. Nothing in the panel takes part.
   */
  async grantCredits(userId: string, credits: number, days: number): Promise<void> {
    const admin = await this.issuer.sessionToken({ userId: 'user_root', azp: WORKER, claims: { role: 'admin' } })
    const res = await this.worker(
      new Request(`${WORKER}/v1/admin/accounts/${userId}/grants`, {
        method: 'POST',
        headers: { authorization: `Bearer ${admin}`, 'content-type': 'application/json' },
        body: JSON.stringify({ credits, days }),
      }),
    )
    if (!res.ok) throw new Error(`grant refused: ${res.status} ${await res.text()}`)
  }

  /**
   * Stripe tells the worker's webhook about a payment, signed as Stripe signs it: by default that
   * the latest Checkout Session was paid. Nothing in the panel takes part.
   */
  async stripeSends(event: Record<string, unknown> = this.stripe.sessionEvent()): Promise<void> {
    const payload = JSON.stringify(event)
    const res = await this.worker(
      new Request(`${WORKER}/stripe/webhook`, {
        method: 'POST',
        headers: { 'stripe-signature': await signature(payload, Date.now()), 'content-type': 'application/json' },
        body: payload,
      }),
    )
    if (!res.ok) throw new Error(`event refused: ${res.status} ${await res.text()}`)
  }

  /** Starts a browser on `tab`, signed in to Notico as `signedInAs` or signed out. */
  static async start(tab: FakeNotionTab, options: { signedInAs?: string } = {}): Promise<FakeBrowser> {
    vi.useFakeTimers({ toFake: ['Date'], now: START })
    const issuer = await (clerk ??= FakeClerk.create())
    const userId = options.signedInAs
    const session = userId && {
      userId,
      name: 'Alice Example',
      email: 'alice@example.com',
      getToken: () => issuer.sessionToken({ userId, azp: EXTENSION }),
    }
    const browser = new FakeBrowser(tab, session || undefined)

    const env: Env = {
      AI: { run: (model, inputs, options) => titleRequests(browser, inputs).run(model, inputs, options) },
      DB: browser.db,
      USAGE: new FakeUsageDataset(),
      CHAT_LIMIT: new FakeRateLimiter(),
      MODEL,
      CLERK_JWT_KEY: issuer.publicKeyPem,
      CLERK_AUTHORIZED_PARTIES: `${EXTENSION}, ${WORKER}`,
      STRIPE: browser.stripe,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
      CREDIT_PRICE: 'price_credits',
      CREDIT_PACKS: [5, 10, 20, 50],
    }
    browser.issuer = issuer
    browser.env = env
    browser.worker = (request) => app.request(request, undefined, env, new FakeExecutionContext())
    // The panel calls fetch(); route it into the worker app, or to OpenRouter or DeepSeek.
    globals.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init)
      if (request.url.startsWith(`${OPENROUTER}/`)) return browser.openRouter.handle(request)
      if (request.url.startsWith(`${DEEPSEEK}/`)) return browser.deepSeek.handle(request)
      if (request.url.startsWith(`${POSTHOG}/`)) return browser.postHog.handle(request)
      const headers = [...request.headers].map(([name, value]) => `${name}: ${value}`).join('\n')
      browser.sentToWorker.push(`${request.url}\n${headers}\n${await request.clone().text()}`)
      return browser.worker(request)
    }
    // A new browser profile: no saved sessions, and nothing in the extension's localStorage.
    globals.indexedDB = new IDBFactory()
    localStorage.clear()

    tab.install()
    const chrome = globals.chrome as { tabs: Record<string, unknown> } & Record<string, unknown>
    chrome.runtime = { getURL: (path: string) => `${EXTENSION}/${path}`, getManifest: () => ({ version: '1.2.3' }) }
    chrome.tabs.create = async ({ url }: { url: string }) => void browser.openedTabs.push(url)
    // Clerk's cookie on the sign-in page, which the panel watches to notice a sign-in or sign-out there.
    chrome.cookies = {
      getAll: async ({ name }: { name: string }) => [{ name, value: session ? '1762603200' : '0' }],
      onChanged: { addListener: () => {} },
    }
    return browser
  }

  /**
   * Opens the side panel: loads sidepanel.html into the document and runs the script it names, so
   * the panel starts as it does in Chrome. Opening it again closes the one before: a new document with new modules;
   * what the browser keeps (IndexedDB, chrome.storage, the sign-in) stays.
   */
  async openPanel(): Promise<void> {
    await closePanel()
    vi.resetModules()
    const page = new DOMParser().parseFromString(
      readFileSync(fileURLToPath(import.meta.resolve('../sidepanel.html')), 'utf8'),
      'text/html',
    )
    const script = page.querySelector('script[type="module"]')!
    script.remove()
    document.body.innerHTML = page.body.innerHTML
    const { fakeClerk } = await import('./clerk')
    if (this.session) fakeClerk.signIn(this.session)
    await act(() => import(/* @vite-ignore */ script.getAttribute('src')!))
  }

  /** The user signs in again, as the account the browser started with, on the sign-in page; Clerk tells the open panel. */
  async signInAgain(): Promise<void> {
    if (!this.session) throw new Error('this browser started signed out')
    const { fakeClerk } = await import('./clerk')
    act(() => fakeClerk.signIn(this.session!))
  }

  /** What the model was sent with its latest call. */
  sentToModel(): { role: string; content?: string }[] {
    return this.ai.calls.at(-1)!.inputs.messages as { role: string; content?: string }[]
  }
}

/** Closes the open panel, if there is one, as Chrome does when its page goes away. */
async function closePanel(): Promise<void> {
  await act(async () => void window.dispatchEvent(new Event('pagehide')))
  document.body.innerHTML = ''
}

/** Closes the panel and puts back what a FakeBrowser replaced. Call it after each test. */
export async function closeBrowser(): Promise<void> {
  await closePanel()
  restoreGlobals()
  delete globals.indexedDB
  vi.useRealTimers()
}
