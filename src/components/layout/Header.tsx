import { Droplets, Mail, Send, TrendingUp, Bot, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { QuickStats } from '@/types'

interface HeaderProps {
  stats: QuickStats
}

export function Header({ stats }: HeaderProps) {
  const adsPercent = (stats.googleAdsSpend / stats.googleAdsBudget) * 100
  const adsNearCap = adsPercent >= 80

  return (
    <header className="border-b border-slate-800 bg-slate-950/80 backdrop-blur-sm sticky top-0 z-50">
      <div className="px-6 py-3 flex items-center justify-between gap-4 flex-wrap">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-blue-600 flex items-center justify-center flex-shrink-0">
            <Droplets className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-white leading-tight">
              RainSoft of the Wiregrass
            </h1>
            <p className="text-xs text-slate-400 leading-tight">Operations Dashboard</p>
          </div>
        </div>

        {/* Quick Stats */}
        <div className="flex items-center gap-2 flex-wrap">
          <StatChip
            icon={<Mail className="w-3.5 h-3.5" />}
            label="Unread"
            value={stats.unreadEmails}
            alert={stats.unreadEmails > 0}
          />
          <StatChip
            icon={<Send className="w-3.5 h-3.5" />}
            label="Pending Posts"
            value={stats.pendingPosts}
          />
          <StatChip
            icon={
              adsNearCap ? (
                <AlertTriangle className="w-3.5 h-3.5" />
              ) : (
                <TrendingUp className="w-3.5 h-3.5" />
              )
            }
            label="Ads Spend"
            value={`$${stats.googleAdsSpend.toFixed(0)}/$${stats.googleAdsBudget}`}
            alert={adsNearCap}
            alertLevel={adsPercent >= 95 ? 'critical' : 'warning'}
            sublabel={`${adsPercent.toFixed(0)}% of cap`}
          />
          <StatChip
            icon={<Bot className="w-3.5 h-3.5" />}
            label="Active Agents"
            value={stats.activeAgents}
            positive
          />
        </div>
      </div>
    </header>
  )
}

interface StatChipProps {
  icon: React.ReactNode
  label: string
  value: string | number
  sublabel?: string
  alert?: boolean
  alertLevel?: 'warning' | 'critical'
  positive?: boolean
}

function StatChip({ icon, label, value, sublabel, alert, alertLevel, positive }: StatChipProps) {
  return (
    <div
      className={cn(
        'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border',
        alert && alertLevel === 'critical'
          ? 'bg-red-950/50 border-red-700 text-red-300'
          : alert && alertLevel === 'warning'
          ? 'bg-yellow-950/50 border-yellow-700 text-yellow-300'
          : alert
          ? 'bg-blue-950/50 border-blue-700 text-blue-300'
          : positive
          ? 'bg-emerald-950/40 border-emerald-800 text-emerald-300'
          : 'bg-slate-900 border-slate-700 text-slate-300'
      )}
    >
      {icon}
      <span className="text-slate-400 hidden sm:inline">{label}:</span>
      <span className="font-semibold">{value}</span>
      {sublabel && <span className="text-slate-500 hidden md:inline">({sublabel})</span>}
    </div>
  )
}
