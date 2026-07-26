/* eslint-disable react-perf/jsx-no-new-function-as-prop -- Segmented options bind their typed value at the leaf button. */
import type { ReactNode } from 'react'

export type StatusTone = 'neutral' | 'good' | 'warn' | 'bad'

export const StatusBadge = ({
  children,
  tone = 'neutral',
}: {
  readonly children: ReactNode
  readonly tone?: StatusTone
}) => <span className={`badge ${tone}`}>{children}</span>

export const SectionHeading = ({ id, children }: { readonly id: string; readonly children: ReactNode }) => (
  <div className="section-heading">
    <h2 id={id}>{children}</h2>
  </div>
)

export const SegmentedControl = <Value extends string>({
  label,
  value,
  options,
  onChange,
  className = '',
}: {
  readonly label: string
  readonly value: Value
  readonly options: ReadonlyArray<{ readonly value: Value; readonly label: string }>
  readonly onChange: (value: Value) => void
  readonly className?: string
}) => (
  <div className={`mode-switch ${className}`} aria-label={label}>
    {options.map((option) => (
      <button
        key={option.value}
        type="button"
        aria-pressed={option.value === value}
        onClick={() => onChange(option.value)}
      >
        {option.label}
      </button>
    ))}
  </div>
)

export const ModeControl = ({ label, children }: { readonly label: string; readonly children: ReactNode }) => (
  <div className="mode-control">
    <span className="mode-label">{label}</span>
    {children}
  </div>
)
