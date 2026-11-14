import { useEffect, useRef, type ReactNode, type Ref } from 'react'
import { Icon } from './icons'

/**
 * The top of the panel: what is open, on one line, then whatever actions the screen has. Chrome's own
 * title bar above the panel already names the extension, so the header does not.
 */
export function Header({ title, children, inert }: { title?: ReactNode; children?: ReactNode; inert?: boolean }) {
  return (
    <header inert={inert}>
      {title !== undefined && <h1 className="title">{title}</h1>}
      {children}
    </header>
  )
}

/**
 * A page over the whole panel, the chat's header included: its own header, with Back and the page's
 * name, then the page. Back, and Escape wherever the focus is, call `onBack`. Not when something on
 * the page took the key for itself (a menu that closes on Escape).
 */
export function Page({
  id,
  title,
  onBack,
  backRef,
  children,
}: {
  id: string
  title: string
  onBack: () => void
  /** The Back button, for a page that moves the focus to it. */
  backRef?: Ref<HTMLButtonElement>
  children: ReactNode
}) {
  const back = useRef(onBack)
  back.current = onBack
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) back.current()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="page-layer">
      <section id={id} className="page" aria-labelledby={`${id}-title`}>
        <header>
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
          <h1 id={`${id}-title`} className="title">
            {title}
          </h1>
        </header>
        <div className="page-body">{children}</div>
      </section>
    </div>
  )
}
