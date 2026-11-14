// Builds the extension's manifest.json from env values. vite.config.ts writes the result into the
// build, and test/manifest.test.ts pins its permissions: Chrome disables an installed extension
// on update when the new version adds a permission warning, so a permission must never
// change unnoticed. It also pins the content security policy, which names the hosts
// the extension's pages may contact (see PRIVACY.md).
import { clerkFrontendApi } from './src/clerk.ts'

/** The env values the manifest is built from (see .env). */
export interface ManifestEnv {
  VITE_CLERK_PUBLISHABLE_KEY?: string
  VITE_CLERK_SYNC_HOST: string
  CLERK_COOKIE_DOMAIN?: string
  CRX_PUBLIC_KEY?: string
  /** Worker base URL. Optional here so the manifest can be built without it; the build requires it. */
  VITE_API_URL?: string
  /** PostHog's ingestion host, where usage events go (src/analytics.ts). Without it the policy names none. */
  VITE_POSTHOG_HOST?: string
}

/** The icon (icons/icon.svg) at each size Chrome asks for; `pnpm icons` exports them into public/icons. */
const ICONS = { 16: 'icons/icon-16.png', 32: 'icons/icon-32.png', 48: 'icons/icon-48.png', 128: 'icons/icon-128.png' }

/** Clerk serves user avatars and provider icons from here, for every instance. */
const CLERK_IMAGE_HOST = 'img.clerk.com'

/**
 * Host permission covering the domain Clerk sets __client_uat on: the sign-in
 * page's registrable domain (e.g. api.cofun.cc -> *.cofun.cc).
 * The last two labels are a guess that fits hosts like example.com; set
 * CLERK_COOKIE_DOMAIN for suffixes such as example.co.uk. IPs and single-label
 * hosts (localhost) get a permission for the host itself.
 */
function clerkCookiePermission(syncHost: string, cookieDomain?: string): string {
  const { protocol, hostname } = new URL(syncHost)
  const labels = hostname.split('.')
  if (cookieDomain) return `${protocol}//*.${cookieDomain.replace(/^\./, '')}/*`
  if (labels.length < 2 || /^[\d.]+$/.test(hostname) || hostname.includes(':')) return `${protocol}//${hostname}/*`
  return `${protocol}//*.${labels.slice(-2).join('.')}/*`
}

/** The APIs where a user's own model is asked (UC-NOTICO-AGENT-002): OpenRouter's, and DeepSeek's. */
const OWN_MODEL_HOSTS = ['https://openrouter.ai', 'https://api.deepseek.com']

/**
 * The policy for the extension's own pages (the side panel and the service worker). Chrome's
 * default only limits scripts; this one limits every kind of load to the extension itself, except
 * requests, which may also go to the worker, Clerk's Frontend API, OpenRouter and DeepSeek (only
 * once the user picks one; a host permission would not widen this list, #46), and PostHog (usage
 * events, unless the user turned them off), and images, which may also
 * come from Clerk's image host. So the browser itself enforces the host list in PRIVACY.md. Notion calls
 * are not made from these pages (they run in the Notion tab).
 */
function contentSecurityPolicy(env: ManifestEnv): string {
  const clerkHost = clerkFrontendApi(env.VITE_CLERK_PUBLISHABLE_KEY ?? '')
  const connect = [
    ...new Set([
      ...(env.VITE_API_URL ? [new URL(env.VITE_API_URL).origin] : []),
      ...(clerkHost ? [`https://${clerkHost}`] : []),
      ...OWN_MODEL_HOSTS,
      ...(env.VITE_POSTHOG_HOST ? [new URL(env.VITE_POSTHOG_HOST).origin] : []),
    ]),
  ]
  return [
    // Everything not named below (frames, fonts, media, workers) loads from the extension only.
    "default-src 'self'",
    "script-src 'self'",
    "object-src 'self'",
    // Clerk's components add their styles as inline <style> elements.
    "style-src 'self' 'unsafe-inline'",
    ["connect-src 'self'", ...connect].join(' '),
    `img-src 'self' data: blob: https://${CLERK_IMAGE_HOST}`,
  ].join('; ')
}

/**
 * The manifest for the given env and version. The store build (`store: true`, for the Chrome Web
 * Store) leaves out `key`: the store signs the item with a key of its own, which sets its ID.
 */
export function buildManifest(env: ManifestEnv, version: string, { store = false }: { store?: boolean } = {}) {
  const clerkHost = clerkFrontendApi(env.VITE_CLERK_PUBLISHABLE_KEY ?? '')
  return {
    manifest_version: 3,
    name: 'Notico: AI copilot for Notion',
    version,
    // The store's summary line: at most 132 characters, which the manifest test pins.
    description:
      'AI copilot for Notion: summarize and edit pages, update databases, search and organize your workspace. No subscription needed.',
    ...(env.CRX_PUBLIC_KEY && !store ? { key: env.CRX_PUBLIC_KEY } : {}),
    icons: ICONS,
    // scripting: Notion calls run in the user's Notion tab (src/notion/tab.ts).
    // tabs: the side panel reads the current tab's URL and title, to tell a Notion tab from others
    // (src/notion/tab.ts) and for the get_current_tab tool (src/tools/current.ts). Host permissions would
    // expose a Notion tab's URL too, but not once the user limits the extension's site access; with
    // tabs the tools still find the tab there and say which access is missing.
    permissions: ['sidePanel', 'storage', 'tabs', 'cookies', 'scripting'],
    host_permissions: [
      'https://www.notion.so/*',
      'https://app.notion.com/*',
      // Clerk's Frontend API. On a production instance the cookies permission also reads Clerk's
      // client cookie from this host (Sync Host).
      ...(clerkHost ? [`https://${clerkHost}/*`] : []),
      // Sign-in page. On a development instance Clerk's client cookie is on this host instead.
      `${new URL(env.VITE_CLERK_SYNC_HOST).origin}/*`,
      // Clerk sets __client_uat on the parent domain (e.g. .cofun.cc). The side
      // panel watches it to notice sign-in and sign-out, and Chrome only reports
      // cookies whose domain the extension has host permission for.
      clerkCookiePermission(env.VITE_CLERK_SYNC_HOST, env.CLERK_COOKIE_DOMAIN),
    ],
    content_security_policy: { extension_pages: contentSecurityPolicy(env) },
    background: { service_worker: 'background.js', type: 'module' },
    // One panel per window, on every tab: it stays open, with its conversation, as the user
    // switches tabs. The Notion tools work only while the current tab is on Notion.
    side_panel: { default_path: 'sidepanel.html' },
    action: { default_title: 'Open Notico', default_icon: ICONS },
  }
}
