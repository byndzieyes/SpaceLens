import { useId, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'

export function Modal({
  title,
  onDismiss,
  getReturnFocus,
  fallbackFocus,
  children
}: {
  title: string
  onDismiss: () => void
  getReturnFocus?: () => HTMLElement | null
  fallbackFocus?: RefObject<HTMLElement | null>
  children: ReactNode
}): React.JSX.Element {
  const titleId = useId()
  const ref = useRef<HTMLDialogElement>(null)

  useLayoutEffect(() => {
    const dialog = ref.current!
    const previous = document.activeElement
    const fallback = fallbackFocus?.current
    dialog.showModal()
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    return () => {
      dialog.close()
      const target = getReturnFocus?.() ?? previous
      if (target instanceof HTMLElement && target.isConnected) target.focus({ preventScroll: true })
      else if (fallback?.isConnected) fallback.focus({ preventScroll: true })
    }
  }, [fallbackFocus, getReturnFocus])

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        onDismiss()
      }}
      className="fixed inset-0 m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-xl border border-border bg-surface p-5 text-text-primary backdrop:bg-background/75 sm:p-6"
    >
      <h3 id={titleId} className="mb-4 text-lg font-semibold">
        {title}
      </h3>
      {children}
    </dialog>
  )
}
