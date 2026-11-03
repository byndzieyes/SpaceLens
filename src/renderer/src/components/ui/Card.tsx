import type { ComponentProps } from 'react'

export function Card({ className = '', ...props }: ComponentProps<'section'>): React.JSX.Element {
  return (
    <section
      className={`rounded-xl border border-border bg-surface p-5 sm:p-6 ${className}`}
      {...props}
    />
  )
}
