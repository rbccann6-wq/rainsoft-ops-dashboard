import { useState, useEffect, useCallback } from 'react'
import { Receipt, RefreshCw, Loader2, AlertCircle, RepeatIcon, Mail, DollarSign } from 'lucide-react'
import { fetchBills } from '@/lib/billsApi'
import type { Bill, BillsSummary } from '@/lib/billsApi'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

const CATEGORY_COLORS: Record<string, string> = {
  Business: 'text-blue-400',
  Personal: 'text-purple-400',
  Insurance: 'text-green-400',
  Other: 'text-slate-400',
}

const TYPE_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  subscription: 'Subscription',
  statement: 'Statement',
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatAmount(amount: number | null) {
  if (amount === null) return '—'
  return `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

type Filter = 'all' | 'Business' | 'Personal' | 'Insurance' | 'recurring'

export function BillsTracker() {
  const [bills, setBills] = useState<Bill[]>([])
  const [summary, setSummary] = useState<BillsSummary | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [paidIds, setPaidIds] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await fetchBills()
      setBills(data.bills)
      setSummary(data.summary)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const filtered = bills.filter(b => {
    if (filter === 'recurring') return b.isRecurring
    if (filter !== 'all') return b.category === filter
    return true
  })

  const tabs: { key: Filter; label: string; count?: number }[] = [
    { key: 'all', label: 'All', count: bills.length },
    { key: 'recurring', label: 'Recurring', count: bills.filter(b => b.isRecurring).length },
    { key: 'Business', label: 'Business', count: summary?.byCategory.Business },
    { key: 'Personal', label: 'Personal', count: summary?.byCategory.Personal },
    { key: 'Insurance', label: 'Insurance', count: summary?.byCategory.Insurance },
  ]

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Receipt className="w-5 h-5 text-blue-400" />
          <h2 className="text-lg font-semibold text-white">Bills & Subscriptions</h2>
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-start gap-3 bg-red-950/40 border border-red-700 rounded-xl p-4">
          <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-red-300">Failed to load bills</p>
            <p className="text-xs text-slate-400 mt-0.5">{error}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={load} className="ml-auto">Retry</Button>
        </div>
      )}

      {/* Summary cards */}
      {summary && !loading && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <Card>
            <div className="p-4 text-center">
              <p className="text-xs text-slate-500 mb-1">Total Found</p>
              <p className="text-2xl font-bold text-white">{summary.total}</p>
              <p className="text-xs text-slate-500 mt-1">last 90 days</p>
            </div>
          </Card>
          <Card>
            <div className="p-4 text-center">
              <p className="text-xs text-slate-500 mb-1">Recurring</p>
              <p className="text-2xl font-bold text-amber-400">{summary.recurring}</p>
              <p className="text-xs text-slate-500 mt-1">subscriptions</p>
            </div>
          </Card>
          <Card>
            <div className="p-4 text-center">
              <p className="text-xs text-slate-500 mb-1">Est. Monthly</p>
              <p className="text-2xl font-bold text-green-400">{formatAmount(summary.estimatedMonthlySpend)}</p>
              <p className="text-xs text-slate-500 mt-1">from email data</p>
            </div>
          </Card>
          <Card>
            <div className="p-4 text-center">
              <p className="text-xs text-slate-500 mb-1">Categories</p>
              <div className="flex justify-center gap-2 mt-2 flex-wrap">
                {Object.entries(summary.byCategory).filter(([,v]) => v > 0).map(([k, v]) => (
                  <span key={k} className={cn('text-xs font-medium', CATEGORY_COLORS[k])}>
                    {v} {k}
                  </span>
                ))}
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex gap-1 border-b border-slate-800 overflow-x-auto">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setFilter(tab.key)}
            className={cn(
              'px-3 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap',
              filter === tab.key
                ? 'border-blue-500 text-white'
                : 'border-transparent text-slate-400 hover:text-slate-300'
            )}
          >
            {tab.label}
            {tab.count !== undefined && tab.count > 0 && (
              <span className="ml-1.5 text-xs bg-slate-800 text-slate-400 px-1.5 py-0.5 rounded-full">
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Scanning 90 days of email…</span>
        </div>
      )}

      {/* Bills list */}
      {!loading && (
        <div className="space-y-2">
          {filtered.length === 0 && !error && (
            <p className="text-sm text-slate-500 py-8 text-center">No bills found for this filter.</p>
          )}
          {filtered.map(bill => (
            <Card key={bill.id}>
              <div className="p-4 flex items-start gap-4">
                {/* Icon */}
                <div className="w-9 h-9 rounded-lg bg-slate-800 flex items-center justify-center flex-shrink-0 mt-0.5">
                  {bill.isRecurring
                    ? <RepeatIcon className="w-4 h-4 text-amber-400" />
                    : <Receipt className="w-4 h-4 text-slate-400" />
                  }
                </div>

                {/* Details */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-semibold text-white">{bill.vendor}</p>
                    <span className={cn('text-xs font-medium', CATEGORY_COLORS[bill.category])}>
                      {bill.category}
                    </span>
                    {bill.isRecurring && (
                      <span className="text-xs text-amber-400/80 flex items-center gap-0.5">
                        <RepeatIcon className="w-3 h-3" /> Recurring ({bill.occurrences}×)
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5 truncate">{bill.subject}</p>
                  <div className="flex items-center gap-3 mt-1.5 text-xs text-slate-500">
                    <span>{formatDate(bill.date)}</span>
                    <span className="capitalize">{TYPE_LABELS[bill.type] ?? bill.type}</span>
                    <a
                      href={`mailto:${bill.senderEmail}`}
                      className="flex items-center gap-1 text-slate-600 hover:text-slate-400 transition-colors"
                      onClick={e => e.stopPropagation()}
                    >
                      <Mail className="w-3 h-3" /> {bill.senderEmail}
                    </a>
                  </div>
                </div>

                {/* Amount + actions */}
                <div className="flex flex-col items-end gap-2 flex-shrink-0">
                  <span className={cn(
                    'text-base font-bold font-mono',
                    bill.amount ? 'text-white' : 'text-slate-600'
                  )}>
                    {formatAmount(bill.amount)}
                  </span>
                  <Button
                    variant={paidIds.has(bill.id) ? 'ghost' : 'success'}
                    size="sm"
                    onClick={() => setPaidIds(prev => {
                      const next = new Set(prev)
                      if (next.has(bill.id)) next.delete(bill.id)
                      else next.add(bill.id)
                      return next
                    })}
                  >
                    <DollarSign className="w-3 h-3" />
                    {paidIds.has(bill.id) ? 'Paid ✓' : 'Mark Paid'}
                  </Button>
                </div>
              </div>

              {/* Paid overlay */}
              {paidIds.has(bill.id) && (
                <div className="px-4 pb-3">
                  <div className="h-px bg-green-800/40" />
                  <p className="text-xs text-green-400/70 mt-2 flex items-center gap-1">
                    ✓ Marked as paid — click again to undo
                  </p>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
