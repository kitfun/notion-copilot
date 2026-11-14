import { useAuth } from '@clerk/chrome-extension'
import type { ModelSettings } from '../models'
import { Avatar, useAccount } from './Account'
import { Page } from './Header'
import { ModelCard } from './Model'

/** The Settings page: everything that isn't money. Which model answers, and the account with Sign out. */
export function Settings({
  model,
  onModelChange,
  onClose,
}: {
  /** Which model answers; undefined while it loads. */
  model?: ModelSettings
  onModelChange: (settings: ModelSettings) => void
  onClose: () => void
}) {
  const { signOut } = useAuth()
  const account = useAccount()

  return (
    <Page id="settings" title="Settings" onBack={onClose}>
      <ModelCard settings={model} onChange={onModelChange} />

      <section className="page-section" aria-labelledby="settings-account">
        <h2 id="settings-account">Account</h2>
        <div className="settings-account">
          <Avatar {...account} />
          <div className="grow">
            <p className="account-name">{account.name}</p>
            {account.email && account.email !== account.name && <p className="account-detail">{account.email}</p>}
          </div>
          <button type="button" className="secondary" onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </section>
    </Page>
  )
}
