// Usage data (UC-NOTICO-PANEL-002): what the panel tells PostHog, as a user's actions cause it. The
// whole panel runs; besides the screen, the tests look at one edge: what PostHog was sent.
import '@testing-library/jest-dom/vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent, { type UserEvent } from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { pageTab, PAGE_URL } from './notion-tab'
import { closeBrowser, FakeBrowser, START } from './panel'
import type { SentEvent } from './posthog'

afterEach(closeBrowser)

async function openPanel() {
  const browser = await FakeBrowser.start(pageTab(), { signedInAs: 'user_alice' })
  await browser.openPanel()
  return { browser, user: userEvent.setup() }
}

async function ask(user: UserEvent, question: string) {
  await user.type(screen.getByRole('textbox', { name: 'Message' }), `${question}{Enter}`)
}

const answered = () => screen.findByRole('button', { name: 'Send' })

async function openSettings(user: UserEvent) {
  await user.click(screen.getByRole('button', { name: 'Account' }))
  await user.click(await screen.findByRole('menuitem', { name: 'Settings' }))
  expect(await screen.findByRole('heading', { name: 'Settings' })).toBeVisible()
}

const usageSwitch = () => screen.findByRole('switch', { name: 'Share usage data' })

/** Every event an action could cause has been sent: the last one a question causes is its end. */
const sent = (browser: FakeBrowser, name: string, times = 1) =>
  waitFor(() => expect(browser.postHog.named(name)).toHaveLength(times))

/**
 * Everything an event may carry, by what kind of value it is. Ids are random, or the account's id;
 * the rest are names from a fixed list, numbers, and booleans.
 */
const ALLOWED: Record<string, (value: unknown) => boolean> = {
  // Who and when.
  token: (v) => v === 'phc_test_project_key',
  distinct_id: (v) => v === 'user_alice' || isUuid(v),
  $device_id: isUuid,
  $session_id: isUuid,
  $user_id: (v) => v === 'user_alice',
  $anon_distinct_id: isUuid,
  $insert_id: (v) => typeof v === 'string' && /^[a-z0-9]{1,32}$/.test(v),
  $time: (v) => typeof v === 'number',
  $is_identified: (v) => typeof v === 'boolean',
  $process_person_profile: (v) => typeof v === 'boolean',
  // The SDK and the browser.
  $lib: (v) => v === 'web',
  $lib_version: (v) => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v),
  $browser: (v) => typeof v === 'string' && /^[A-Za-z ]{1,30}$/.test(v),
  $browser_version: (v) => v === null || typeof v === 'number',
  $os: (v) => typeof v === 'string' && /^[A-Za-z ]{1,30}$/.test(v),
  $geoip_disable: (v) => v === true,
  // What happened.
  version: (v) => v === '1.2.3',
  product: (v) => v === 'notico',
  provider: oneOf('hosted', 'openrouter', 'deepseek'),
  notion_tab: (v) => typeof v === 'boolean',
  outcome: oneOf('done', 'stopped', 'step_limit', 'error'),
  rounds: Number.isInteger,
  tool_calls: Number.isInteger,
  tool: oneOf('read_page', 'other'),
  ok: (v) => typeof v === 'boolean',
  status: oneOf('done', 'failed', 'skipped', 'stopped', 'declined'),
  error_code: oneOf('no_access', 'other'),
  how: oneOf('mention', 'button'),
  pack: Number.isInteger,
}

function oneOf(...known: string[]) {
  return (value: unknown) => typeof value === 'string' && known.includes(value)
}

function isUuid(value: unknown): boolean {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
}

/** What of `event` is not allowed: a field that is not listed, or a value that is not of its kind. */
function notAllowed({ event, properties, ...rest }: SentEvent): string[] {
  return [
    // Beside its name and properties, an event has only its own random id and its time.
    ...Object.keys(rest).filter((key) => !['uuid', 'timestamp'].includes(key)),
    ...Object.entries(properties)
      .filter(([name, value]) => !ALLOWED[name]?.(value))
      .map(([name, value]) => `${event}.${name}=${JSON.stringify(value)}`),
  ]
}

describe('usage data', () => {
  it('[UC-NOTICO-PANEL-002-S01] a question sends what happened, in listed fields only, and nothing of the question, the answer, or the page', async () => {
    const { browser, user } = await openPanel()
    browser.ai.script.push(
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ part: 1 }) }] },
      // A tool that does not exist, named by the model: its name is the model's text.
      { toolCalls: [{ name: 'summon_the_roadmap_wizard', arguments: '{}' }] },
      { reply: 'The plan ships in March.' },
    )

    await ask(user, 'What does the secret plan say?')
    expect(await screen.findByText('The plan ships in March.')).toBeVisible()
    await answered()
    await sent(browser, 'question_ended')

    const { postHog } = browser
    expect(postHog.named('question_asked')).toMatchObject([{ provider: 'hosted', notion_tab: true }])
    expect(postHog.named('tool_called')).toMatchObject([
      { tool: 'read_page', ok: true, status: 'done' },
      { tool: 'other', ok: false, status: 'failed' },
    ])
    expect(postHog.named('question_ended')).toMatchObject([
      { provider: 'hosted', outcome: 'done', rounds: 3, tool_calls: 2 },
    ])
    // Every event carries which extension and which version sent it.
    for (const { properties } of postHog.events.filter((each) => !each.event.startsWith('$'))) {
      expect(properties).toMatchObject({ product: 'notico', version: '1.2.3' })
    }

    // Only the events the panel names, and the one that joins the device to the account.
    expect([...new Set(postHog.names())].toSorted()).toEqual(
      ['$identify', 'panel_opened', 'question_asked', 'question_ended', 'signed_in', 'tool_called'].toSorted(),
    )
    // Every field of every event is one that is listed, with a value of its kind.
    expect(postHog.events.flatMap(notAllowed)).toEqual([])
    // Every event, the joining one included, tells PostHog to work out no location.
    expect(postHog.events.filter((each) => each.properties.$geoip_disable !== true)).toEqual([])
    // And all of it went to the one address, with no text of the conversation or the page anywhere in it.
    expect(postHog.requests.length).toBe(postHog.events.length)
    for (const request of postHog.requests) {
      expect(request.split('\n')[0]).toBe('POST https://posthog.test/e/')
      for (const text of [
        'secret plan',
        'ships in March',
        'summon_the_roadmap_wizard',
        'Fixture page',
        new URL(PAGE_URL).hostname,
        'chrome-extension',
        'alice@example.com',
        'Alice',
      ]) {
        expect(request).not.toContain(text)
      }
    }
  })

  it('[UC-NOTICO-PANEL-002-S02] turned off in the settings, nothing more is sent, also after the panel opens again', async () => {
    const { browser, user } = await openPanel()
    // On until the user turns it off.
    await sent(browser, 'signed_in')
    await openSettings(user)
    expect(await usageSwitch()).toBeChecked()
    await sent(browser, 'settings_opened')

    await user.click(await usageSwitch())
    expect(await usageSwitch()).not.toBeChecked()
    const before = browser.postHog.requests.length

    // Using the panel: back to the chat, a question with a tool, a new chat, the settings again.
    await user.click(screen.getByRole('button', { name: 'Back' }))
    browser.ai.script.push(
      { toolCalls: [{ name: 'read_page', arguments: JSON.stringify({ part: 1 }) }] },
      { reply: 'It is a fixture.' },
    )
    await ask(user, 'What does this page say?')
    expect(await screen.findByText('It is a fixture.')).toBeVisible()
    await answered()
    await user.click(screen.getByRole('button', { name: 'New chat' }))

    // The panel closes and opens again: the choice is kept, and the panel starts without sending.
    await browser.openPanel()
    await openSettings(userEvent.setup())
    expect(await usageSwitch()).not.toBeChecked()
    expect(browser.postHog.requests.length).toBe(before)

    // Turned on again, what happens from then on is sent.
    await user.click(await usageSwitch())
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    await waitFor(() => expect(browser.postHog.names().slice(before)).toContain('chat_created'))
    expect(browser.postHog.names().slice(before)).not.toContain('question_asked')
  })

  // Turned off, nothing may follow: so an event that could not be delivered is never sent again later.
  it('[UC-NOTICO-PANEL-002-S02] an event PostHog did not take is not sent again, however long the panel stays open', async () => {
    const { browser } = await openPanel()
    await sent(browser, 'signed_in')
    browser.postHog.failWith = 503
    const before = browser.postHog.requests.length
    // From here the test moves the timers itself: the SDK would retry after seconds, then minutes.
    vi.useFakeTimers({ now: START })

    screen.getByRole('button', { name: 'New chat' }).click()
    await vi.advanceTimersByTimeAsync(0)
    expect(browser.postHog.names().slice(before)).toEqual(['chat_created'])

    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000)
    expect(browser.postHog.requests.length).toBe(before + 1)
  })
})
