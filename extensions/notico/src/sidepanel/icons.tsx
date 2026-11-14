import type { ReactNode } from 'react'

/** The Cofun mark: an open ring with a dot just outside its gap (see `extensions/notico/icons/icon.svg`). */
export function Mark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="-21 -21 42 42" aria-hidden="true" focusable="false">
      <path
        d="M12.9 -1.6A13 13 0 1 1 1.6 -12.9"
        fill="none"
        stroke="currentColor"
        strokeWidth="7"
        strokeLinecap="round"
      />
      <circle cx="12" cy="-12" r="5" fill="currentColor" />
    </svg>
  )
}

// Drawn on a 16-unit grid, as outlines in the current text color (see `.icon` in style.css).
const SHAPES = {
  history: <path d="M8 4.5V8l2.3 1.5M2.5 8a5.5 5.5 0 1 0 1.7-4M2.5 3v2.5H5" />,
  compose: (
    <path d="M8 3H4a1.5 1.5 0 0 0-1.5 1.5V12A1.5 1.5 0 0 0 4 13.5h7.5A1.5 1.5 0 0 0 13 12V8M11.5 2.5l2 2L8.5 9.5l-2.5.5.5-2.5z" />
  ),
  send: <path d="M8 13V3.5M4 7l4-4 4 4" />,
  copy: (
    <>
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5" />
    </>
  ),
  back: <path d="M9.5 3.5L5 8l4.5 4.5" />,
  chevron: <path d="M4.5 10l3.5-3.5 3.5 3.5" />,
  /** Leads on to another page. */
  forward: <path d="M6 3.5L10.5 8 6 12.5" />,
  /** A stack of coins: credits. */
  coins: (
    <>
      <ellipse cx="8" cy="5" rx="5" ry="2.2" />
      <path d="M3 5v3c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2V5M3 8v3c0 1.2 2.2 2.2 5 2.2s5-1 5-2.2V8" />
    </>
  ),
  gear: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M3.6 12.4l1.1-1.1M11.3 4.7l1.1-1.1" />
    </>
  ),
  signOut: <path d="M6.5 13.5h-3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3M10 11l3-3-3-3M13 8H6" />,
  close: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  /** An arrow down into a tray: save to Notion. */
  save: <path d="M8 2.5v7M5 6.5l3 3 3-3M2.5 10v2A1.5 1.5 0 0 0 4 13.5h8A1.5 1.5 0 0 0 13.5 12v-2" />,
  page: (
    <>
      <path d="M4.5 2.5h4.8L12 5.2v8.3H4.5z" />
      <path d="M9 2.5v3h3M6.5 8.5h3.5M6.5 10.8h3.5" />
    </>
  ),
  database: (
    <>
      <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11M6.5 6.5v6.5" />
    </>
  ),
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.3 10.3l3.2 3.2" />
    </>
  ),
  trash: <path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.1a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.1M6.8 7v4M9.2 7v4" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  ask: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3.5M8 11v.01" />
    </>
  ),
  dots: <path d="M3.5 8v.01M8 8v.01M12.5 8v.01" strokeWidth="2.4" />,
  minus: <path d="M4 8h8" />,
  pencil: <path d="M10.5 3l2.5 2.5-7.5 7.5-3 .5.5-3zM9 4.5L11.5 7" />,
  eye: (
    <>
      <path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  summary: <path d="M3 4h10M3 7h10M3 10h6M3 13h4" />,
  todo: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5.5 8l2 2 3-4" />
    </>
  ),
  list: <path d="M6 4h7.5M6 8h7.5M6 12h7.5M2.5 4v.01M2.5 8v.01M2.5 12v.01" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </>
  ),
  columns: (
    <>
      <rect x="2.5" y="3" width="3" height="10" rx="1" />
      <rect x="6.5" y="3" width="3" height="7" rx="1" />
      <rect x="10.5" y="3" width="3" height="4" rx="1" />
    </>
  ),
  question: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M6.5 6.5a1.5 1.5 0 1 1 2 1.4c-.4.2-.5.5-.5.9v.4M8 11.2v.1" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 7.5v3.5M8 5.2v.1" />
    </>
  ),
  square: <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none" />,
  slash: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M4.2 11.8l7.6-7.6" />
    </>
  ),
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof SHAPES

/** A decorative icon: whatever it sits in carries the name. */
export function Icon({ name }: { name: IconName }) {
  return (
    <svg className="icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {SHAPES[name]}
    </svg>
  )
}
