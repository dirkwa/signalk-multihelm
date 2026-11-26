import { useEffect, useRef, type ReactNode } from 'react'

interface Props {
  title: string
  /** While true, the sheet cannot be closed, so an answer reaches the sheet that asked. */
  busy: boolean
  close: () => void
  children: ReactNode
}

/** A modal sheet from the bottom of the screen, closed with its button, Escape or a tap beside it. */
export function Sheet({ title, busy, close, children }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const element = dialog.current
    if (element && !element.open) {
      element.showModal()
    }
    return () => {
      element?.close()
    }
  }, [])

  const dismiss = (): void => {
    if (!busy) {
      close()
    }
  }

  return (
    <dialog
      ref={dialog}
      className="sheet"
      aria-label={title}
      onCancel={(e) => {
        e.preventDefault()
        dismiss()
      }}
      onClick={(e) => {
        if (e.target === dialog.current) {
          dismiss()
        }
      }}
    >
      <div className="sheet-body">
        <header className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="button" disabled={busy} onClick={dismiss}>
            Close
          </button>
        </header>
        {children}
      </div>
    </dialog>
  )
}
