import type { ComponentProps } from 'react'

type BadgeProps = ComponentProps<'span'> & {
  variant?: 'neutral' | 'success' | 'warning' | 'error'
}

const variants = {
  neutral: 'border-border bg-surface-elevated text-text-secondary',
  success: 'border-success/20 bg-success/10 text-success',
  warning: 'border-warning/20 bg-warning/10 text-warning',
  error: 'border-error/20 bg-error/10 text-error'
}

export function Badge({
  variant = 'neutral',
  className = '',
  ...props
}: BadgeProps): React.JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-xs font-medium ${variants[variant]} ${className}`}
      {...props}
    />
  )
}
