import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Mail, Target, TrendingUp, ArrowRight, Loader2, Package, RefreshCw } from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import type { Email } from '@/types'
import { fetchEmails } from '@/lib/emailApi'

export function OverviewPage() {
  const [emails, setEmails] = useState<Email[]>([])
  const [loadingEmails, setLoadingEmails] = useState(true)
  const [leadStats, setLeadStats] = useState<{ lowes: number; smartmail: number; sfSynced: number } | null>(null)
  const [dealStats, setDealStats] = useState<any>(null)
  const [orderStats, setOrderStats] = useState<any>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date())

  const refreshAll = useCallback(async () => {
    setRefreshing(true)
    setLoadingEmails(true)
    try {
      // Bypass HTTP cache so the user actually gets fresh server data on click.
      const noCache: RequestInit = { cache: 'no-store' }

      const tasks: Promise<unknown>[] = [
        fetchEmails({ top: 50 })
          .then(data => setEmails(data.emails))
          .catch(() => {})
          .finally(() => setLoadingEmails(false)),

        fetch('/api/all-leads', noCache)
          .then(r => r.ok ? r.json() : null)
          .then(d => {
            if (d) {
              const lowes = d.lowes || []
              const smart = d.smartmail || []
              const sfSynced = [...lowes, ...smart].filter((l: any) => l.sf_lead_id).length
              setLeadStats({ lowes: lowes.length, smartmail: smart.length, sfSynced })
            }
          })
          .catch(() => {}),

        fetch('/api/deal-tracker/stats', noCache)
          .then(r => r.ok ? r.json() : null)
          .then(d => { if (d) setDealStats(d) })
          .catch(() => {}),

        fetch('/api/pentair/stats', noCache)
          .then(r => r.ok ? r.json() : null)
          .then(d => { if (d?.recentActivity) setOrderStats(d.recentActivity) })
          .catch(() => {}),
      ]

      await Promise.allSettled(tasks)
      setLastRefreshed(new Date())
    } finally {
      setRefreshing(false)
    }
  }, [])

  // Initial load
  useEffect(() => { refreshAll() }, [refreshAll])

  // Refetch when the tab regains focus or the document becomes visible
  useEffect(() => {
    const onFocus = () => refreshAll()
    const onVisibility = () => { if (document.visibilityState === 'visible') refreshAll() }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refreshAll])

  const unread = emails.filter((e) => !e.isRead)

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-semibold text-white">Operations Overview</h2>
          <p className="text-sm text-slate-400 mt-1">
            RainSoft Gulf Coast — daily snapshot
          </p>
        </div>
        <button
          onClick={refreshAll}
          disabled={refreshing}
          title={`Last refreshed ${lastRefreshed.toLocaleTimeString()}`}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
          {refreshing ? 'Refreshing…' : `Refresh (${lastRefreshed.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})`}
        </button>
      </div>

      {/* Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Unread Email */}
        <Card>
          <CardHeader>
            <CardTitle>
              <Mail className="w-4 h-4 text-blue-400" />
              Unread Emails
            </CardTitle>
            <Link to="/email" className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {loadingEmails ? (
              <div className="flex items-center gap-2 py-2 text-slate-500 text-sm">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading...
              </div>
            ) : unread.length === 0 ? (
              <p className="text-sm text-slate-500">All caught up!</p>
            ) : (
              unread.slice(0, 4).map((email) => (
                <div key={email.id} className="flex items-start gap-3 py-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-1.5 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white truncate">{email.sender}</p>
                    <p className="text-xs text-slate-400 truncate">{email.subject}</p>
                  </div>
                  <span className="text-xs text-slate-500 whitespace-nowrap ml-auto">{email.time}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* Lead Stats */}
        <Card>
          <CardHeader>
            <CardTitle>
              <Target className="w-4 h-4 text-blue-400" />
              Leads
            </CardTitle>
            <Link to="/all-leads" className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </CardHeader>
          <CardContent>
            {leadStats ? (
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-slate-800/50 rounded-lg p-3 text-center">
                  <p className="text-xs text-slate-500">Lowe's</p>
                  <p className="text-lg font-semibold font-mono text-blue-300 mt-1">{leadStats.lowes}</p>
                </div>
                <div className="bg-slate-800/50 rounded-lg p-3 text-center">
                  <p className="text-xs text-slate-500">SmartMail</p>
                  <p className="text-lg font-semibold font-mono text-purple-300 mt-1">{leadStats.smartmail}</p>
                </div>
                <div className="bg-slate-800/50 rounded-lg p-3 text-center">
                  <p className="text-xs text-slate-500">In Salesforce</p>
                  <p className="text-lg font-semibold font-mono text-emerald-300 mt-1">{leadStats.sfSynced}</p>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 py-2 text-slate-500 text-sm">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading...
              </div>
            )}
          </CardContent>
        </Card>

        {/* Deal Tracker Summary */}
        <Card>
          <CardHeader>
            <CardTitle>
              <TrendingUp className="w-4 h-4 text-blue-400" />
              Deals
            </CardTitle>
            <Link to="/deal-tracker" className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </CardHeader>
          <CardContent>
            {dealStats ? (
              <div className="grid grid-cols-3 gap-3">
                <div className="bg-slate-800/50 rounded-lg p-3 text-center">
                  <p className="text-xs text-slate-500">Total</p>
                  <p className="text-lg font-semibold font-mono text-white mt-1">{dealStats.total ?? '—'}</p>
                </div>
                <div className="bg-slate-800/50 rounded-lg p-3 text-center">
                  <p className="text-xs text-slate-500">Active</p>
                  <p className="text-lg font-semibold font-mono text-blue-300 mt-1">{dealStats.active ?? '—'}</p>
                </div>
                <div className="bg-slate-800/50 rounded-lg p-3 text-center">
                  <p className="text-xs text-slate-500">Funded (Mo)</p>
                  <p className="text-lg font-semibold font-mono text-emerald-300 mt-1">{dealStats.fundedThisMonth ?? '—'}</p>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 py-2 text-slate-500 text-sm">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading...
              </div>
            )}
          </CardContent>
        </Card>

        {/* Orders */}
        <Card>
          <CardHeader>
            <CardTitle>
              <Package className="w-4 h-4 text-blue-400" />
              Recent Orders
            </CardTitle>
            <Link to="/orders" className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {orderStats?.length > 0 ? (
              orderStats.slice(0, 4).map((item: any, i: number) => (
                <div key={i} className="flex items-center gap-3 py-1">
                  <Badge variant={item.type === 'order' ? 'active' : item.type === 'shipment' ? 'scheduled' : item.type === 'payment' ? 'posted' : 'completed'}>
                    {item.type}
                  </Badge>
                  <p className="text-sm text-slate-300 truncate flex-1">
                    {item.orderNumber || item.invoiceNumber || item.tracking || item.subject || '—'}
                  </p>
                  <span className="text-xs text-slate-500 whitespace-nowrap">
                    {item.ts ? new Date(item.ts).toLocaleDateString() : ''}
                  </span>
                </div>
              ))
            ) : (
              <p className="text-sm text-slate-500">No recent activity</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
