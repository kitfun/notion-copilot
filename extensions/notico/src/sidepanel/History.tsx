import { useEffect, useRef, useState } from 'react'
import { grantDatesText, grantLeftText, grantTitle, wholeCredits, type GrantsPage } from '../credits'

/** How the history is read from the worker: a page of grants, from where the one before ended. */
export type ReadGrants = (before?: string) => Promise<GrantsPage>

/**
 * The history of the user's credits: every grant they were given (free weekly credits, purchases,
 * credits granted by hand), newest first, each with its dates, what a purchase cost, and what is
 * left, went unspent, or was taken back. No usage: that is on the Credits page, for the last 30
 * days. Read a page at a time, when it opens, not with the credits; a read that fails keeps what
 * was read before it, says so here, and touches nothing else.
 */
export function History({ read }: { read: ReadGrants }) {
  const [pages, setPages] = useState<GrantsPage[]>([])
  const [status, setStatus] = useState<'reading' | 'ready' | 'failed'>('reading')
  // Only the newest read counts, and none once the history is gone.
  const reads = useRef(0)
  const next = pages.at(-1)?.next ?? null

  async function more() {
    const mine = ++reads.current
    setStatus('reading')
    try {
      const page = await read(next ?? undefined)
      if (mine !== reads.current) return
      setPages((pages) => [...pages, page])
      setStatus('ready')
    } catch {
      if (mine === reads.current) setStatus('failed')
    }
  }

  useEffect(() => {
    void more()
    return () => void reads.current++
  }, [])

  const given = pages.flatMap((page) => page.grants)
  // One moment for the whole list: what has expired by now.
  const now = Date.now()

  return (
    <div className="history">
      {given.length > 0 && (
        <ul className="history-list" aria-label="Credits you were given">
          {given.map((grant, i) => {
            const left = grantLeftText(grant, now)
            return (
              <li key={i}>
                <span className="grow">
                  <span className="history-title">{grantTitle(grant)}</span>
                  <span className="account-detail">{grantDatesText(grant, now)}</span>
                </span>
                <span className="history-amount">
                  <span className={grant.revoked === undefined ? 'history-plus' : 'history-plus muted'}>
                    +{wholeCredits(grant.amount)}
                  </span>
                  <span className={left.taken ? 'account-detail taken' : 'account-detail'}>{left.text}</span>
                </span>
              </li>
            )
          })}
        </ul>
      )}
      {given.length === 0 && status === 'ready' && (
        <p className="account-detail">No credits yet. Your free credits start with your next question.</p>
      )}
      {status === 'reading' && (
        <p role="status" className="account-detail">
          Loading…
        </p>
      )}
      {status === 'failed' && (
        <>
          <p role="alert">Your credits could not be loaded.</p>
          <button type="button" className="primary" onClick={() => void more()}>
            Try again
          </button>
        </>
      )}
      {status === 'ready' && next !== null && (
        <button type="button" className="history-more" onClick={() => void more()}>
          Show earlier
        </button>
      )}
    </div>
  )
}
