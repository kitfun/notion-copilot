import { useEffect, useRef, useState } from 'react'
import { loadAnalyticsEnabled, saveAnalyticsEnabled, track } from '../analytics'
import {
  creditsText,
  dayText,
  daysText,
  sourceText,
  usdText,
  when,
  wholeCredits,
  type Credits,
  type CreditsState,
  type Pack,
  type Packs,
} from '../credits'
import { Avatar, useAccount } from './Account'
import { History, type HistoryReads } from './History'
import { Icon } from './icons'
import { ModelCard } from './Model'
import type { ModelSettings } from '../models'

/** Buying credits, as the settings page needs it. */
export interface Buying {
  /** Reads the packs on offer. */
  packs: () => Promise<Packs>
  /** Opens Checkout for the pack of `quantity` in a new tab. Throws when it can't. */
  buy: (quantity: number) => Promise<void>
}

/**
 * The settings page: the account, the model providers and their models, the packs of credits to buy, the
 * credits with their dates, usage per day, and whether usage data is sent. The history of the
 * credits opens from the credits, in place of the page, and leads back to it.
 */
export function Settings({
  credits,
  onRetry,
  history,
  model,
  onModelChange,
  at,
  buying,
  onClose,
}: {
  credits: CreditsState
  /** Reads the credits again, after a read that failed. */
  onRetry: () => void
  /** Reads the history of the credits, when the user opens it. */
  history: HistoryReads
  /** Which model answers; undefined while it loads. */
  model?: ModelSettings
  /** Saves what `update` makes of the model settings as they are when it is saved. */
  onModelChange: (update: (settings: ModelSettings) => ModelSettings) => void
  /** The section to put the focus on as the page opens; Back has it otherwise. */
  at?: 'providers'
  buying: Buying
  onClose: () => void
}) {
  const account = useAccount()
  const [historyOpen, setHistoryOpen] = useState(false)
  const backRef = useRef<HTMLButtonElement>(null)
  const historyRef = useRef<HTMLButtonElement>(null)

  // Back, and Escape wherever the focus is: from the history to the page, from the page to the
  // chat. Not when something above the page took the key for itself: the account menu, open over
  // the page, closes on Escape and stops there.
  const back = useRef(onClose)
  back.current = historyOpen ? () => setHistoryOpen(false) : onClose
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) back.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // The focus follows: to Back when the history opens, and to what opened it when it closes.
  const shown = useRef(historyOpen)
  useEffect(() => {
    if (shown.current === historyOpen) return
    shown.current = historyOpen
    ;(historyOpen ? backRef : historyRef).current?.focus()
  }, [historyOpen])

  const head = (
    <div className="sheet-head">
      <button
        ref={backRef}
        className="icon-button tip-below tip-start"
        aria-label="Back"
        data-tip="Back"
        autoFocus
        onClick={() => back.current()}
      >
        <Icon name="back" />
      </button>
      <h2 id="settings-title">{historyOpen ? 'Credit history' : 'Settings'}</h2>
    </div>
  )

  if (historyOpen) {
    return (
      <section id="settings" aria-labelledby="settings-title">
        {head}
        <History reads={history} />
      </section>
    )
  }

  return (
    <section id="settings" aria-labelledby="settings-title">
      {head}

      <section className="card" aria-labelledby="settings-account">
        <h3 id="settings-account">Account</h3>
        <div className="settings-account">
          <Avatar {...account} />
          <div>
            <p className="account-name">{account.name}</p>
            {account.email && account.email !== account.name && <p className="account-detail">{account.email}</p>}
          </div>
        </div>
      </section>

      <ModelCard settings={model} onChange={onModelChange} focus={at === 'providers'} />

      <section className="card" aria-labelledby="settings-credits">
        <h3 id="settings-credits">Credits</h3>
        {credits.status === 'loading' && <p className="account-detail">Loading credits…</p>}
        {credits.status === 'unavailable' && (
          <>
            <p role="alert">Your credits could not be loaded. You can still ask questions.</p>
            <button className="primary" onClick={onRetry}>
              Try again
            </button>
          </>
        )}
        {credits.status === 'ready' && <Balance credits={credits.credits} />}
        {/* Read only when it is opened, so it is there to open whether or not the credits could be read. */}
        <button
          ref={historyRef}
          type="button"
          className="link"
          onClick={() => {
            track({ event: 'credits_history_opened' })
            setHistoryOpen(true)
          }}
        >
          Credit history
        </button>
      </section>

      <BuyCredits buying={buying} />

      {credits.status === 'ready' && (
        <section className="card" aria-labelledby="settings-usage">
          <h3 id="settings-usage">Usage</h3>
          <Usage usage={credits.credits.usage} />
        </section>
      )}

      <UsageData />
    </section>
  )
}

/**
 * Whether usage data is sent (see analytics.ts): on until the user turns it off, for this device.
 * Turned off, nothing more is sent, from this panel at once.
 */
function UsageData() {
  // Not known until storage was read: the switch shows nothing it might have to take back.
  const [enabled, setEnabled] = useState<boolean>()

  useEffect(() => {
    let closed = false
    loadAnalyticsEnabled().then(
      (stored) => !closed && setEnabled(stored),
      (err: unknown) => console.error('Could not read the usage data setting', err),
    )
    return () => void (closed = true)
  }, [])

  function change(next: boolean) {
    setEnabled(next)
    saveAnalyticsEnabled(next).catch((err: unknown) => console.error('Could not save the usage data setting', err))
  }

  return (
    <section className="card" aria-labelledby="settings-privacy">
      <h3 id="settings-privacy">Privacy</h3>
      <label className="switch">
        <input
          type="checkbox"
          role="switch"
          checked={enabled ?? false}
          disabled={enabled === undefined}
          aria-describedby="settings-privacy-detail"
          onChange={(e) => change(e.target.checked)}
        />
        <span className="switch-track" aria-hidden="true" />
        Share usage data
      </label>
      <p id="settings-privacy-detail" className="account-detail">
        Which features you use and whether they worked, to help improve Notico. Never your messages, the replies, or
        anything from your pages.
      </p>
    </section>
  )
}

/** What is left, each lot of credits with when it expires, and when the next free credits arrive. */
function Balance({ credits: { balance, free, grants } }: { credits: Credits }) {
  return (
    <>
      <p className="settings-value">{balance > 0 ? `${creditsText(balance)} left` : 'No credits left'}</p>
      {balance < 0 && (
        <p className="account-detail">
          {free.started
            ? `You overspent ${creditsText(-balance)}. They come out of the next credits you get.`
            : // The balance already counts the free credits to come: this is what they leave unpaid.
              `After your next free credits you still owe ${creditsText(-balance)}. They come out of the credits after those.`}
        </p>
      )}
      <ul className="grants" aria-label="Your credits">
        {grants.map((grant, i) => (
          <li key={i}>
            <span>{sourceText(grant.source)}</span>
            <span className="account-detail">
              {grant.left > 0
                ? `${wholeCredits(grant.left)} left, expire ${when(grant.expiresAt)}`
                : `Used up, until ${when(grant.expiresAt)}`}
            </span>
          </li>
        ))}
        {!free.started && (
          <li>
            <span>Free weekly credits</span>
            <span className="account-detail">
              {free.toCome > 0
                ? `${wholeCredits(free.toCome)}, not started: valid for ${daysText(free.lastsMs)} from your next question`
                : 'Not started: they go to what you overspent'}
            </span>
          </li>
        )}
      </ul>
      <p className="account-detail">
        {free.started
          ? `Your next free credits arrive with your first question after ${when(free.until)}.`
          : 'Your free credits start with your next question.'}
      </p>
    </>
  )
}

/**
 * The packs of credits on offer, read when the page opens. Choosing one opens Stripe's Checkout in a
 * new tab; the credits arrive once the payment goes through, and the panel reads them again when the
 * user comes back to it.
 */
function BuyCredits({ buying }: { buying: Buying }) {
  const [packs, setPacks] = useState<{ status: 'loading' } | { status: 'ready'; packs: Pack[] } | { status: 'failed' }>(
    { status: 'loading' },
  )
  const [checkout, setCheckout] = useState<'idle' | 'opening' | 'opened' | 'failed'>('idle')
  const reads = useRef(0)

  async function read() {
    const mine = ++reads.current
    setPacks({ status: 'loading' })
    let next: typeof packs
    try {
      next = { status: 'ready', packs: (await buying.packs()).packs }
    } catch {
      next = { status: 'failed' }
    }
    if (mine === reads.current) setPacks(next)
  }

  useEffect(() => {
    void read()
    // A page that closed takes no answer.
    return () => void reads.current++
  }, [])

  async function buy(quantity: number) {
    setCheckout('opening')
    try {
      await buying.buy(quantity)
      setCheckout('opened')
    } catch {
      setCheckout('failed')
    }
  }

  return (
    <section className="card" aria-labelledby="settings-buy">
      <h3 id="settings-buy">Buy credits</h3>
      {packs.status === 'loading' && <p className="account-detail">Loading…</p>}
      {packs.status === 'failed' && (
        <>
          <p role="alert">Buying credits is unavailable right now.</p>
          <button className="primary" onClick={() => void read()}>
            Try again
          </button>
        </>
      )}
      {packs.status === 'ready' && (
        <>
          <p>
            Credits you buy are valid for one year from the day you buy them. A one-time purchase, not a subscription.
          </p>
          <p className="account-detail">
            Credits pay for Notico's own model; questions answered by your own model on OpenRouter spend none. Bought
            credits are spent after your free credits. Prices are in US dollars; tax may be added at checkout.
          </p>
          <ul className="packs" aria-label="Packs of credits">
            {packs.packs.map(({ quantity, credits, usdCents }) => (
              <li key={quantity}>
                <button
                  type="button"
                  className="pack"
                  aria-label={`Buy ${wholeCredits(credits * 1_000_000)} credits for ${usdText(usdCents)}`}
                  disabled={checkout === 'opening'}
                  onClick={() => void buy(quantity)}
                >
                  <span>{wholeCredits(credits * 1_000_000)} credits</span>
                  <span className="account-detail">{usdText(usdCents)}</span>
                </button>
              </li>
            ))}
          </ul>
          {checkout === 'opened' && (
            <p role="status" className="account-detail">
              Checkout opened in a new tab. Your credits show here once the payment goes through.
            </p>
          )}
          {checkout === 'failed' && <p role="alert">Checkout could not be opened. Try again in a moment.</p>}
        </>
      )}
    </section>
  )
}

/** Credits used on each day that used any, newest first. */
function Usage({ usage }: { usage: Credits['usage'] }) {
  if (usage.byDay.length === 0) return <p className="account-detail">No credits used in the last {usage.days} days.</p>
  return (
    <table className="usage">
      <caption>Credits used per day, last {usage.days} days</caption>
      <tbody>
        {usage.byDay.map(({ day, microCredits }) => (
          <tr key={day}>
            <th scope="row">{dayText(day)}</th>
            <td>{wholeCredits(microCredits, 'nearest')}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
