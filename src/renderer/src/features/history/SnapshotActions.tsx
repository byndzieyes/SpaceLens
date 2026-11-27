import { useCallback, useId, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { createPortal } from 'react-dom'
import { ChartColumn, Ellipsis, FolderTree, GitCompareArrows, Trash2 } from 'lucide-react'
import type { ScanHistoryItem } from '../../../../shared/history'
import type { SnapshotView } from '../../../../shared/snapshotSelection'
import { formatPreciseScanDate } from '../../lib/scanDisplay'

export function SnapshotActions({
  scan,
  onOpen,
  onCompare,
  onDelete,
  fallbackFocus
}: {
  scan: ScanHistoryItem
  onOpen: (view: SnapshotView, scan: ScanHistoryItem) => void
  onCompare: (scan: ScanHistoryItem) => void
  onDelete: (scan: ScanHistoryItem) => void
  fallbackFocus: RefObject<HTMLElement | null>
}): React.JSX.Element {
  const id = useId()
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const openAtEnd = useRef(false)
  const close = useCallback((restore: boolean): void => {
    setOpen(false)
    if (restore) trigger.current?.focus({ preventScroll: true })
  }, [])
  const position = useCallback((): void => {
    const anchor = trigger.current
    const popup = menu.current
    if (!anchor || !popup) return
    const { top, bottom, right } = anchor.getBoundingClientRect()
    const { width, height } = popup.getBoundingClientRect()
    const below = bottom + 4
    const above = top - 4 - height
    popup.style.left = `${Math.max(8, Math.min(right - width, window.innerWidth - width - 8))}px`
    popup.style.top = `${Math.max(8, Math.min(below + height <= window.innerHeight - 8 ? below : above, window.innerHeight - height - 8))}px`
  }, [])

  useLayoutEffect(() => {
    if (open) position()
  }, [open, position, scan])

  useLayoutEffect(() => {
    if (!open) return
    const anchor = trigger.current!
    const popup = menu.current!
    const fallback = fallbackFocus.current
    const outside = (event: PointerEvent): void => {
      if (
        event.target instanceof Node &&
        !anchor.contains(event.target) &&
        !popup.contains(event.target)
      )
        close(false)
    }
    const scroll = (event: Event): void => {
      if (event.target instanceof Node && !popup.contains(event.target)) position()
    }
    const items = popup.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
    const first = openAtEnd.current ? items.length - 1 : 0
    items[first]?.focus({ preventScroll: true })
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', scroll, true)
    return () => {
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', position)
      window.removeEventListener('scroll', scroll, true)
      if (popup.contains(document.activeElement) && fallback?.isConnected)
        fallback.focus({ preventScroll: true })
    }
  }, [close, fallbackFocus, open, position])

  const activate = (action: () => void): void => {
    close(true)
    action()
  }
  const menuItem =
    'flex w-full items-center gap-2 rounded-sm px-3 py-2 text-left text-sm hover:bg-surface-hover focus:bg-surface-hover focus-visible:-outline-offset-2'

  return (
    <>
      <button
        ref={trigger}
        type="button"
        aria-label={`Actions for ${scan.rootPath} completed ${formatPreciseScanDate(scan.finishedAt)}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => {
          if (open) close(true)
          else {
            openAtEnd.current = false
            setOpen(true)
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
          event.preventDefault()
          openAtEnd.current = event.key === 'ArrowUp'
          setOpen(true)
        }}
        className="inline-flex size-8 items-center justify-center rounded-md border border-border bg-surface-elevated hover:bg-surface-hover focus-visible:outline-offset-1"
      >
        <Ellipsis size={17} aria-hidden="true" />
      </button>
      {open &&
        createPortal(
          <div
            id={id}
            ref={menu}
            role="menu"
            aria-label="Snapshot actions"
            onBlur={(event) => {
              if (
                event.relatedTarget instanceof Node &&
                !event.currentTarget.contains(event.relatedTarget)
              )
                close(false)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Escape' || event.key === 'Tab') {
                if (event.key === 'Escape') event.preventDefault()
                close(true)
                return
              }
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
              event.preventDefault()
              const items = [
                ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
              ]
              const current = items.indexOf(document.activeElement as HTMLButtonElement)
              let next = 0
              if (event.key === 'End') next = items.length - 1
              if (event.key === 'ArrowDown') next = (current + 1) % items.length
              if (event.key === 'ArrowUp') next = (current + items.length - 1) % items.length
              items[next]?.focus({ preventScroll: true })
            }}
            className="fixed z-50 max-h-[calc(100dvh-1rem)] w-48 max-w-[calc(100vw-1rem)] overflow-y-auto rounded-lg border border-border bg-surface-elevated p-1 shadow-lg shadow-background/35"
          >
            <button
              role="menuitem"
              tabIndex={-1}
              type="button"
              className={menuItem}
              onClick={() => activate(() => onOpen('explorer', scan))}
            >
              <FolderTree size={16} aria-hidden="true" /> Open in Explorer
            </button>
            <button
              role="menuitem"
              tabIndex={-1}
              type="button"
              className={menuItem}
              onClick={() => activate(() => onOpen('insights', scan))}
            >
              <ChartColumn size={16} aria-hidden="true" /> Open in Insights
            </button>
            <button
              role="menuitem"
              tabIndex={-1}
              type="button"
              className={menuItem}
              onClick={() => activate(() => onCompare(scan))}
            >
              <GitCompareArrows size={16} aria-hidden="true" /> Compare snapshot
            </button>
            <div role="separator" className="my-1 border-t border-separator" />
            <button
              role="menuitem"
              tabIndex={-1}
              type="button"
              className={`${menuItem} text-error`}
              onClick={() => activate(() => onDelete(scan))}
            >
              <Trash2 size={16} aria-hidden="true" /> Delete snapshot
            </button>
          </div>,
          document.body
        )}
    </>
  )
}
