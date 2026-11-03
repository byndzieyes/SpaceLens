import type { ComponentProps } from 'react'

type ButtonProps = ComponentProps<'button'> & {
  variant?: 'primary' | 'secondary'
}

const variants = {
  primary: 'bg-accent text-on-accent hover:bg-accent-hover active:bg-accent-active',
  secondary:
    'border border-border bg-surface-elevated text-text-primary hover:bg-surface-hover active:bg-surface-active'
}

export function Button({
  variant = 'primary',
  type = 'button',
  className = '',
  ...props
}: ButtonProps): React.JSX.Element {
  return (
    <button
      type={type}
      className={`inline-flex min-h-10 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors duration-150 disabled:pointer-events-none disabled:opacity-50 motion-reduce:transition-none ${variants[variant]} ${className}`}
      {...props}
    />
  )
}
