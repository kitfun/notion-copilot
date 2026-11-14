import { useAuth, useUser } from '@clerk/chrome-extension'
import { useState, type Ref } from 'react'
import { wholeCredits, type CreditsState } from '../credits'
import { Icon } from './icons'
import { useMenu } from './menu'

/** Who is signed in, as Clerk knows them. Notico only shows it: there is nothing here to change the account. */
export function useAccount(): { name: string; email: string; imageUrl: string } {
  const { user } = useUser()
  const email = user?.primaryEmailAddress?.emailAddress ?? ''
  return { name: user?.fullName || email || 'Signed in', email, imageUrl: user?.imageUrl ?? '' }
}

/** The account's picture, or its initial when there is none or it does not load. */
export function Avatar({ name, imageUrl }: { name: string; imageUrl: string }) {
  const [failed, setFailed] = useState(false)
  return (
    <span className="account-avatar" aria-hidden="true">
      {imageUrl && !failed ? (
        <img src={imageUrl} alt="" onError={() => setFailed(true)} />
      ) : (
        name.trim().charAt(0).toUpperCase()
      )}
    </span>
  )
}

/** The balance on the Credits item: whole credits, nothing while it loads, and that it is unavailable when the read failed. */
function balanceOf(state: CreditsState): { shown: string; spoken: string } {
  if (state.status === 'loading') return { shown: '', spoken: 'Credits' }
  if (state.status === 'unavailable') return { shown: 'Unavailable', spoken: 'Credits, unavailable' }
  const left = wholeCredits(Math.max(state.credits.balance, 0))
  return { shown: left, spoken: `Credits, ${left} left` }
}

/**
 * The avatar in the header and the menu it opens: who is signed in, then Credits (with the balance)
 * and Settings, each opening its page, and Sign out. The panel's own, in place of Clerk's user menu:
 * Notico offers no account management.
 */
export function AccountMenu({
  credits,
  onOpen,
  onCredits,
  onSettings,
  buttonRef,
}: {
  credits: CreditsState
  /** Called each time the menu opens, so the credits in it can be read again. */
  onOpen: () => void
  onCredits: () => void
  onSettings: () => void
  /** The avatar button, so whoever closes a page can put the focus back on it. */
  buttonRef: Ref<HTMLButtonElement>
}) {
  const { signOut } = useAuth()
  const account = useAccount()
  // Escape and Tab, the arrow keys, and a press elsewhere, as every menu of the panel does.
  const { open, setOpen, rootRef, menuRef, onKeyDown } = useMenu()
  const balance = balanceOf(credits)
  const choose = (then: () => void) => () => {
    setOpen(false)
    then()
  }

  return (
    <div className="account" ref={rootRef} onKeyDown={onKeyDown}>
      <button
        ref={buttonRef}
        className="account-button tip-below"
        aria-label="Account"
        data-tip="Account"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen()
          setOpen(!open)
        }}
      >
        <Avatar {...account} />
      </button>
      {open && (
        <div className="account-popover">
          <div className="account-who" id="account-who">
            <p className="account-name">{account.name}</p>
            {account.email && account.email !== account.name && <p className="account-detail">{account.email}</p>}
          </div>
          {/* Opening moves the focus to the first item: the description tells a screen reader who is signed in. */}
          <div ref={menuRef} role="menu" aria-label="Account" aria-describedby="account-who">
            <hr />
            <button role="menuitem" tabIndex={-1} aria-label={balance.spoken} onClick={choose(onCredits)}>
              <Icon name="coins" />
              <span className="grow">Credits</span>
              <span className="menu-value">{balance.shown}</span>
            </button>
            <button role="menuitem" tabIndex={-1} onClick={choose(onSettings)}>
              <Icon name="gear" />
              <span className="grow">Settings</span>
            </button>
            <hr />
            <button role="menuitem" tabIndex={-1} className="quiet" onClick={() => void signOut()}>
              <Icon name="signOut" />
              <span className="grow">Sign out</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
