import { cn } from '@/lib/utils'

interface ProgressBarProps {
  value: number
  max?: number
  className?: string
  showLabel?: boolean
  colorThresholds?: {
    warning: number
    critical: number
  }
  label?: string
}

export function ProgressBar({
  value,
  max = 100,
  className,
  showLabel = false,
  colorThresholds = { warning: 70, critical: 90 },
  label,
}: ProgressBarProps) {
  const percent = Math.min((value / max) * 100, 100)
  const isCritical = percent >= colorThresholds.critical
  const isWarning = percent >= colorThresholds.warning

  return (
    <div className={cn('w-full', className)}>
      {(showLabel || label) && (
        <div className="flex justify-between items-center mb-1.5">
          {label && <span className="text-xs text-slate-400">{label}</span>}
          {showLabel && (
            <span
              className={cn(
                'text-xs font-mono font-medium',
                isCritical ? 'text-red-400' : isWarning ? 'text-yellow-400' : 'text-emerald-400'
              )}
            >
              {percent.toFixed(0)}%
            </span>
          )}
        </div>
      )}
      <div className="h-2 bg-slate-800 rounded-full overflow-hidden">
        <div
          className={cn(
            'h-full rounded-full transition-all duration-500',
            isCritical
              ? 'bg-red-500'
              : isWarning
              ? 'bg-yellow-500'
              : 'bg-emerald-500'
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}
