import { ClerkProvider, Show, useAuth } from '@clerk/chrome-extension'
import { StrictMode, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { identify, track } from '../analytics'
import { clerkSyncHost } from '../clerk'
import { Chat } from './Chat'
import { Header } from './Header'
import { Mark } from './icons'
import './style.css'

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string
// Web page where users sign in. The Clerk session it starts is synced into the extension.
const SIGN_IN_HOST = import.meta.env.VITE_CLERK_SYNC_HOST as string
const PANEL_URL = chrome.runtime.getURL('sidepanel.html')

// Clerk doesn't fully sync auth state into an open side panel, so reload the
// panel when the sign-in page signs in or out. Only react to a change in
// signed-in state: other session cookies are rewritten on every token refresh,
// and reloading then would wipe the conversation.
//
// Clerk's __client_uat_<suffix> cookie is "0" when signed out and a timestamp
// when signed in. It lives on the sign-in page's parent domain, which other
// Clerk apps may share, so watch only the name suffixed for this publishable
// key, and read it by URL so parent-domain cookies are included.
async function uatCookieName(): Promise<string> {
  // Same as Clerk's getCookieSuffix: first 8 chars of base64url(SHA-1(publishable key)).
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(PUBLISHABLE_KEY))
  const suffix = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .slice(0, 8)
  return `__client_uat_${suffix}`
}

// Reading by URL can return both a host-only and a parent-domain cookie with this name, in no
// fixed order. A stale "0" left on one of them must not hide a live session on the other.
async function readSignedIn(name: string): Promise<boolean> {
  const cookies = await chrome.cookies.getAll({ url: SIGN_IN_HOST, name })
  return cookies.some((cookie) => cookie.value !== '' && cookie.value !== '0')
}

uatCookieName()
  .then(async (name) => {
    let signedIn = await readSignedIn(name)
    let reloadTimer: number | undefined
    chrome.cookies.onChanged.addListener(({ cookie }) => {
      if (cookie.name !== name) return
      clearTimeout(reloadTimer)
      reloadTimer = window.setTimeout(async () => {
        const now = await readSignedIn(name)
        if (now !== signedIn) location.reload()
        signedIn = now
      }, 500)
    })
  })
  .catch(console.error)

function openSignIn() {
  track({ event: 'sign_in_opened' })
  chrome.tabs.create({ url: `${SIGN_IN_HOST}/login` })
}

// Each account gets its own chat and sessions; keyed so a change of account starts over.
function SignedInChat() {
  const { userId } = useAuth()
  return userId ? <Chat key={userId} userId={userId} /> : <Header />
}

// Until Clerk knows whether anyone is signed in, neither screen shows; the panel is not left blank.
function WhileLoading() {
  const { isLoaded } = useAuth()
  return isLoaded ? null : <Header />
}

/** Tells analytics who is signed in, once Clerk knows: usage is counted per account, and per device before sign-in. */
function Identity() {
  const { isLoaded, userId } = useAuth()
  useEffect(() => {
    if (isLoaded) identify(userId ?? null)
  }, [isLoaded, userId])
  return null
}

function App() {
  return (
    <ClerkProvider
      publishableKey={PUBLISHABLE_KEY}
      syncHost={clerkSyncHost(PUBLISHABLE_KEY, SIGN_IN_HOST)}
      // Clerk's SDK reports its own usage to clerk-telemetry.com when the instance is a
      // development one. The extension contacts only the hosts PRIVACY.md lists, so it is off
      // whatever the instance.
      telemetry={false}
      afterSignOutUrl={PANEL_URL}
      signInFallbackRedirectUrl={PANEL_URL}
      signUpFallbackRedirectUrl={PANEL_URL}
    >
      <WhileLoading />
      <Identity />

      <Show when="signed-out">
        <Header />
        <div className="signed-out">
          <Mark className="hero-mark" />
          <p>Sign in to use Notico.</p>
          <button className="primary" onClick={openSignIn}>
            Sign in
          </button>
        </div>
      </Show>

      <Show when="signed-in">
        <SignedInChat />
      </Show>
    </ClerkProvider>
  )
}

track({ event: 'panel_opened' })
const root = createRoot(document.getElementById('root')!)
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
)
// Closing the panel ends its work: a question still running stops with the chat (see Chat).
// Not when the page is only kept for later (`persisted`): it would come back with nothing in it.
window.addEventListener('pagehide', (event) => {
  if (!event.persisted) root.unmount()
})
