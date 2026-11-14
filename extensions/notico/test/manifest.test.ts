// The extension's manifest (extensions/notico/manifest.ts). Chrome disables an installed extension on
// update when the new version adds a permission warning, so the permissions are pinned here: a
// change to them must change this file in the same pull request, where a reviewer sees it.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildManifest, type ManifestEnv } from '../manifest'

const NOTION = ['https://www.notion.so/*', 'https://app.notion.com/*']
const CLERK_HOST = 'clerk.example.com'
/** A publishable key as Clerk builds it: the Frontend API host and a `$`, in base64 without padding. */
const PUBLISHABLE_KEY = `pk_live_${Buffer.from(`${CLERK_HOST}$`).toString('base64').replace(/=+$/, '')}`

function manifest(env: Partial<ManifestEnv> & Pick<ManifestEnv, 'VITE_CLERK_SYNC_HOST'>) {
  return buildManifest({ VITE_CLERK_PUBLISHABLE_KEY: PUBLISHABLE_KEY, ...env }, '1.2.3')
}

/** The committed build config of the hosted extension (extensions/notico/.env), as `KEY=value` lines. */
function hostedEnv(): Record<string, string> {
  const text = readFileSync(new URL('../.env', import.meta.url), 'utf8')
  return Object.fromEntries(
    text
      .split('\n')
      .filter((line) => /^\w+=/.test(line))
      .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]),
  )
}

describe('extension manifest', () => {
  // What the published extension asks its users for. A change to extensions/notico/.env that changes
  // these (another Clerk instance, another sign-in host) must change this test too.
  it('ships with exactly these permissions and host permissions', () => {
    const env = hostedEnv()
    const json = buildManifest({ ...env, VITE_CLERK_SYNC_HOST: env.VITE_CLERK_SYNC_HOST! }, '1.2.3')
    expect(json.permissions).toEqual(['sidePanel', 'storage', 'tabs', 'cookies', 'scripting'])
    expect(json.host_permissions).toEqual([
      'https://www.notion.so/*',
      'https://app.notion.com/*',
      'https://clerk.cofun.cc/*',
      'https://api.cofun.cc/*',
      'https://*.cofun.cc/*',
    ])
  })

  // Where the published extension's own pages may load from and send requests to: the hosts
  // PRIVACY.md lists, enforced by the browser. A change to extensions/notico/.env or to the policy that
  // adds a host must change this test and PRIVACY.md in the same pull request.
  it('ships with a content security policy that allows only these hosts', () => {
    const env = hostedEnv()
    const json = buildManifest({ ...env, VITE_CLERK_SYNC_HOST: env.VITE_CLERK_SYNC_HOST! }, '1.2.3')
    expect(json.content_security_policy.extension_pages).toBe(
      "default-src 'self'; script-src 'self'; object-src 'self'; style-src 'self' 'unsafe-inline'; " +
        "connect-src 'self' https://api.cofun.cc https://clerk.cofun.cc https://openrouter.ai https://api.deepseek.com " +
        'https://us.i.posthog.com; ' +
        "img-src 'self' data: blob: https://img.clerk.com",
    )
  })

  it('allows requests only to the configured worker, Clerk host, OpenRouter, DeepSeek, and PostHog host, whatever the env', () => {
    const csp = (env: Partial<ManifestEnv>) =>
      manifest({ VITE_CLERK_SYNC_HOST: 'https://app.example.com', ...env }).content_security_policy.extension_pages
    expect(csp({ VITE_API_URL: 'http://localhost:8787/v1' })).toContain(
      `connect-src 'self' http://localhost:8787 https://${CLERK_HOST} https://openrouter.ai https://api.deepseek.com;`,
    )
    // PostHog's host, for usage events, is the one the build is configured with: the origin alone.
    expect(csp({ VITE_API_URL: 'http://localhost:8787/v1', VITE_POSTHOG_HOST: 'https://eu.i.posthog.com/' })).toContain(
      `connect-src 'self' http://localhost:8787 https://${CLERK_HOST} https://openrouter.ai https://api.deepseek.com https://eu.i.posthog.com;`,
    )
    // Without a worker URL or a Clerk host, requests go only to OpenRouter and DeepSeek, for a user's own model.
    expect(csp({ VITE_CLERK_PUBLISHABLE_KEY: '' })).toContain(
      "connect-src 'self' https://openrouter.ai https://api.deepseek.com;",
    )
  })

  it('asks for exactly these permissions, whatever the env', () => {
    const envs: ManifestEnv[] = [
      { VITE_CLERK_SYNC_HOST: 'https://api.cofun.cc' },
      { VITE_CLERK_SYNC_HOST: 'https://app.example.co.uk', CLERK_COOKIE_DOMAIN: 'example.co.uk' },
      { VITE_CLERK_SYNC_HOST: 'http://localhost:8787', CRX_PUBLIC_KEY: 'public-key' },
    ]
    for (const env of envs) {
      expect(manifest(env).permissions).toEqual(['sidePanel', 'storage', 'tabs', 'cookies', 'scripting'])
    }
  })

  it('asks for no optional permissions and injects no content scripts', () => {
    const json: Record<string, unknown> = manifest({ VITE_CLERK_SYNC_HOST: 'https://api.cofun.cc' })
    expect(Object.keys(json).sort()).toEqual(
      [
        'action',
        'background',
        'content_security_policy',
        'description',
        'host_permissions',
        'icons',
        'manifest_version',
        'name',
        'permissions',
        'side_panel',
        'version',
      ].sort(),
    )
  })

  it('has a description short enough for the Chrome Web Store summary', () => {
    // Chrome's manifest reference caps the description at 132 characters; the store shows it as the summary.
    expect(manifest({ VITE_CLERK_SYNC_HOST: 'https://sync.example.com' }).description.length).toBeLessThanOrEqual(132)
  })

  it('lists icons that exist in the build at the size they are listed for', () => {
    const json = manifest({ VITE_CLERK_SYNC_HOST: 'https://api.cofun.cc' })
    expect(Object.keys(json.icons)).toEqual(['16', '32', '48', '128'])
    expect(json.action.default_icon).toEqual(json.icons)
    for (const [size, file] of Object.entries(json.icons)) {
      // Vite copies public/ into the build as it is. A PNG starts with its signature and the
      // IHDR chunk, which holds the width and height at bytes 16 and 20.
      const png = readFileSync(new URL(`../public/${file}`, import.meta.url))
      expect(png.subarray(1, 4).toString('latin1')).toBe('PNG')
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([Number(size), Number(size)])
    }
  })

  it("covers Notion, Clerk, the sign-in page, and the sign-in page's parent domain", () => {
    expect(manifest({ VITE_CLERK_SYNC_HOST: 'https://api.cofun.cc' }).host_permissions).toEqual([
      ...NOTION,
      `https://${CLERK_HOST}/*`,
      'https://api.cofun.cc/*',
      'https://*.cofun.cc/*',
    ])
  })

  it('covers CLERK_COOKIE_DOMAIN instead of guessing the parent domain', () => {
    const env = { VITE_CLERK_SYNC_HOST: 'https://app.example.co.uk' }
    // The guess is wrong for a suffix like co.uk, which is why the setting exists.
    expect(manifest(env).host_permissions.at(-1)).toBe('https://*.co.uk/*')
    for (const CLERK_COOKIE_DOMAIN of ['example.co.uk', '.example.co.uk']) {
      expect(manifest({ ...env, CLERK_COOKIE_DOMAIN }).host_permissions).toEqual([
        ...NOTION,
        `https://${CLERK_HOST}/*`,
        'https://app.example.co.uk/*',
        'https://*.example.co.uk/*',
      ])
    }
  })

  it('covers only the host itself for localhost', () => {
    expect(manifest({ VITE_CLERK_SYNC_HOST: 'http://localhost:8787' }).host_permissions).toEqual([
      ...NOTION,
      `https://${CLERK_HOST}/*`,
      'http://localhost:8787/*',
      'http://localhost/*',
    ])
  })

  it('covers only the host itself for an IP address', () => {
    expect(manifest({ VITE_CLERK_SYNC_HOST: 'http://127.0.0.1:8787' }).host_permissions).toEqual([
      ...NOTION,
      `https://${CLERK_HOST}/*`,
      'http://127.0.0.1:8787/*',
      'http://127.0.0.1/*',
    ])
    expect(manifest({ VITE_CLERK_SYNC_HOST: 'http://[::1]:8787' }).host_permissions).toEqual([
      ...NOTION,
      `https://${CLERK_HOST}/*`,
      'http://[::1]:8787/*',
      'http://[::1]/*',
    ])
  })

  it('leaves out the Clerk host when the publishable key names none', () => {
    expect(
      manifest({ VITE_CLERK_SYNC_HOST: 'https://api.cofun.cc', VITE_CLERK_PUBLISHABLE_KEY: '' }).host_permissions,
    ).toEqual([...NOTION, 'https://api.cofun.cc/*', 'https://*.cofun.cc/*'])
  })

  it('pins the extension ID with the public key, when one is set', () => {
    const env = { VITE_CLERK_SYNC_HOST: 'https://api.cofun.cc' }
    expect(manifest(env)).not.toHaveProperty('key')
    expect(manifest({ ...env, CRX_PUBLIC_KEY: 'public-key' })).toMatchObject({ key: 'public-key', version: '1.2.3' })
  })

  // The Chrome Web Store signs the item with its own key, which sets the ID, so the zip uploaded
  // there carries no `key`. Everything else is what local builds ship.
  it('leaves out only the key in the store build', () => {
    const env = hostedEnv()
    const hosted = { ...env, VITE_CLERK_SYNC_HOST: env.VITE_CLERK_SYNC_HOST! }
    expect(env.CRX_PUBLIC_KEY).toBeTruthy()
    const local = buildManifest(hosted, '1.2.3')
    const store = buildManifest(hosted, '1.2.3', { store: true })
    expect(local).toHaveProperty('key', env.CRX_PUBLIC_KEY)
    expect(store).not.toHaveProperty('key')
    const { key: _, ...rest } = local
    expect(store).toEqual(rest)
  })
})
