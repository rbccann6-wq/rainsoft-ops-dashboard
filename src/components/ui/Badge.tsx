import { cn } from '@/lib/utils'

type BadgeVariant = 'default' | 'unread' | 'read' | 'active' | 'working' | 'idle' | 'draft' | 'scheduled' | 'posted' | 'failed' | 'completed' | 'in-progress' | 'pending' | 'warning'

interface BadgeProps {
  variant?: BadgeVariant
  children: React.ReactNode
  className?: string
}

const variants: Record<BadgeVariant, string> = {
  default: 'bg-slate-800 text-slate-300 border-slate-700',
  unread: 'bg-blue-900/60 text-blue-300 border-blue-700',
  read: 'bg-slate-800 text-slate-500 border-slate-700',
  active: 'bg-emerald-900/60 text-emerald-300 border-emerald-700',
  working: 'bg-blue-900/60 text-blue-300 border-blue-700 animate-pulse',
  idle: 'bg-slate-800 text-slate-400 border-slate-700',
  draft: 'bg-yellow-900/50 text-yellow-300 border-yellow-700',
  scheduled: 'bg-blue-900/60 text-blue-300 border-blue-700',
  posted: 'bg-emerald-900/60 text-emerald-300 border-emerald-700',
  failed: 'bg-red-900/60 text-red-300 border-red-700',
  completed: 'bg-emerald-900/60 text-emerald-300 border-emerald-700',
  'in-progress': 'bg-blue-900/60 text-blue-300 border-blue-700 animate-pulse',
  pending: 'bg-yellow-900/50 text-yellow-300 border-yellow-700',
  warning: 'bg-orange-900/60 text-orange-300 border-orange-700',
}

export function Badge({ variant = 'default', children, className }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border',
        variants[variant],
        className
      )}
    >
      {children}
    </span>
  )
}
