import { useState, useEffect, useCallback } from 'react'
import { DollarSign, RefreshCw, Loader2, AlertCircle, CheckCircle2, XCircle, Clock, SkipForward, Wifi, WifiOff, ChevronDown, ChevronUp } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { cn } from '@/lib/utils'

interface Run {
  id: number
  run_id: string
  applicant_name: string | null
  co_applicant_name: string | null
  sale_amount: number | null
  amount_financed: number | null
  product: string | null
  lead_source: string | null
  promo: string | null
  portal: string | null
  status: string
  stops: string[] | null
  skip_reason: string | null
  result_summary: string | null
  sales_rep: string | null
  install_date: string | null
  email_subject: string | null
  email_received_at: string | null
  processed_at: string
  error_message: string | null
}

interface Stats {
  total: number
  approved: number
  declined: number
  pending: number
  stopped: number
  skipped: number
  error: number
  thisWeek: number
  thisMonth: number
}

interface WebhookStatus {
  subscribed: boolean
  subscriptionId?: string
  expiresAt?: string
  hoursLeft?: number
  healthy?: boolean
  message?: string
  error?: string
}

const STATUS_CONFIG: Record<string, { label: string; color: string; icon: React.ElementType }> = {
  approved:         { label: 'Approved',        color: 'text-emerald-400 bg-emerald-950/40 border-emerald-800/50', icon: CheckCircle2 },
  declined:         { label: 'Declined',        color: 'text-red-400 bg-red-950/40 border-red-800/50',            icon: XCircle },
  stopped:          { label: 'Needs Review',    color: 'text-amber-400 bg-amber-950/40 border-amber-800/50',      icon: AlertCircle },
  pending_approval: { label: 'Awaiting Approval', color: 'text-violet-400 bg-violet-950/40 border-violet-800/50', icon: Clock },
  submitting:       { label: 'Submitting…',     color: 'text-blue-400 bg-blue-950/40 border-blue-800/50',         icon: Loader2 },
  submitted:        { label: 'Submitted',       color: 'text-blue-400 bg-blue-950/40 border-blue-800/50',         icon: Clock },
  pending:          { label: 'Pending',         color: 'text-blue-400 bg-blue-950/40 border-blue-800/50',         icon: Clock },
  skipped:          { label: 'Skipped',         color: 'text-slate-400 bg-slate-800/40 border-slate-700/50',      icon: SkipForward },
  rejected:         { label: 'Rejected',        color: 'text-slate-400 bg-slate-800/40 border-slate-700/50',      icon: XCircle },
  error:            { label: 'Error',           color: 'text-red-400 bg-red-950/40 border-red-800/50',            icon: XCircle },
}

function statusConfig(status: string) {
  return STATUS_CONFIG[status] ?? { label: status, color: 'text-slate-400 bg-slate-800 border-slate-700', icon: Clock }
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)  return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function fmt$(n: number | null) {
  if (n == null) return '—'
  return '$' + Number(n).toLocaleString()
}

async function apiFetch<T>(path: string): Promise<T> {
  const r = await fetch(`/api${path}`)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

export function FinanceDashboard() {
  const [runs, setRuns]               = useState<Run[]>([])
  const [stats, setStats]             = useState<Stats | null>(null)
  const [webhook, setWebhook]         = useState<WebhookStatus | null>(null)
  const [loading, setLoading]         = useState(true)
  const [error, setError]             = useState<string | null>(null)
  const [selected, setSelected]       = useState<Run | null>(null)
  const [expandedStops, setExpandedStops] = useState<Set<number>>(new Set())
  const [approving, setApproving]     = useState(false)
  const [actionMsg, setActionMsg]     = useState<string | null>(null)
  const [selectedPortal, setSelectedPortal] = useState<string>('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [runsData, statsData, webhookData] = await Promise.all([
        apiFetch<Run[]>('/finance-agent/runs'),
        apiFetch<Stats>('/finance-agent/stats'),
        apiFetch<WebhookStatus>('/finance-agent/status').catch(() => ({ subscribed: false })),
      ])
      setRuns(runsData)
      setStats(statsData)
      setWebhook(webhookData)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function approve(run: Run) {
    setApproving(true)
    setActionMsg(null)
    const portal = selectedPortal || run.portal || 'ispc'
    try {
      const r = await fetch(`/api/finance-agent/approve/${encodeURIComponent(run.run_id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portal }),
      })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Failed')
      setActionMsg(`✅ Submitted to ${portal.toUpperCase()}! Check the portal for the decision.`)
      await load()
    } catch (err) {
      setActionMsg('❌ ' + (err as Error).message)
    } finally {
      setApproving(false)
    }
  }

  async function reject(run: Run) {
    setApproving(true)
    try {
      await fetch(`/api/finance-agent/reject/${encodeURIComponent(run.run_id)}`, { method: 'POST' })
      setSelected(null)
      await load()
    } finally {
      setApproving(false)
    }
  }

  function toggleStops(id: number) {
    setExpandedStops(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <DollarSign className="w-5 h-5 text-emerald-400" />
          <h2 className="text-lg font-semibold text-white">Finance Agent</h2>
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-3 bg-red-950/40 border border-red-700 rounded-xl p-4">
          <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {/* Webhook status */}
      {webhook && (
        <Card>
          <div className="p-4 flex items-center gap-3">
            {webhook.subscribed && webhook.healthy
              ? <Wifi className="w-4 h-4 text-emerald-400 flex-shrink-0" />
              : <WifiOff className="w-4 h-4 text-red-400 flex-shrink-0" />}
            <div className="flex-1 min-w-0">
              <p className={cn('text-sm font-medium', webhook.subscribed && webhook.healthy ? 'text-emerald-400' : 'text-red-400')}>
                {webhook.subscribed && webhook.healthy
                  ? 'Webhook active — watching for FastField emails'
                  : webhook.message || 'Webhook inactive'}
              </p>
              {webhook.expiresAt && (
                <p className={cn('text-xs mt-0.5', (webhook.hoursLeft ?? 0) < 24 ? 'text-amber-400' : 'text-slate-500')}>
                  Renews in {webhook.hoursLeft}h · {new Date(webhook.expiresAt).toLocaleDateString()}
                  {(webhook.hoursLeft ?? 0) < 24 && ' ⚠️ renewing soon'}
                </p>
              )}
            </div>
          </div>
        </Card>
      )}

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card><div className="p-4 text-center">
            <p className="text-2xl font-bold text-white">{stats.total}</p>
            <p className="text-xs text-slate-500 mt-1">Total runs</p>
            <p className="text-xs text-slate-600 mt-0.5">{stats.thisWeek} this week</p>
          </div></Card>
          <Card><div className="p-4 text-center">
            <p className="text-2xl font-bold text-emerald-400">{stats.approved}</p>
            <p className="text-xs text-slate-500 mt-1">Approved</p>
          </div></Card>
          <Card><div className="p-4 text-center">
            <p className="text-2xl font-bold text-amber-400">{stats.stopped}</p>
            <p className="text-xs text-slate-500 mt-1">Needs review</p>
          </div></Card>
          <Card><div className="p-4 text-center">
            <p className="text-2xl font-bold text-red-400">{stats.declined}</p>
            <p className="text-xs text-slate-500 mt-1">Declined</p>
            <p className="text-xs text-slate-600 mt-0.5">{stats.skipped} skipped</p>
          </div></Card>
        </div>
      )}

      {/* Runs table */}
      <Card>
        {loading && runs.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading…</span>
          </div>
        ) : runs.length === 0 ? (
          <div className="py-16 text-center">
            <DollarSign className="w-10 h-10 text-slate-700 mx-auto mb-3" />
            <p className="text-white font-medium">No credit apps processed yet</p>
            <p className="text-sm text-slate-500 mt-1">
              The agent is watching for FastField emails from noreply@fastfieldforms.com
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="text-left px-4 py-3 text-xs text-slate-500 font-medium">Time</th>
                  <th className="text-left px-3 py-3 text-xs text-slate-500 font-medium">Applicant</th>
                  <th className="text-left px-3 py-3 text-xs text-slate-500 font-medium">Amount</th>
                  <th className="text-left px-3 py-3 text-xs text-slate-500 font-medium hidden md:table-cell">Portal</th>
                  <th className="text-left px-3 py-3 text-xs text-slate-500 font-medium">Status</th>
                  <th className="px-3 py-3 w-16"></th>
                </tr>
              </thead>
              <tbody>
                {runs.map(run => {
                  const cfg = statusConfig(run.status)
                  const Icon = cfg.icon
                  const expanded = expandedStops.has(run.id)
                  return (
                    <>
                      <tr key={run.id}
                        className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
                        <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                          {timeAgo(run.processed_at)}
                        </td>
                        <td className="px-3 py-3">
                          <p className="text-sm text-white font-medium truncate max-w-[140px]">
                            {run.applicant_name || '—'}
                          </p>
                          {run.co_applicant_name && (
                            <p className="text-xs text-slate-500 truncate max-w-[140px]">
                              + {run.co_applicant_name}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-3 text-sm text-white whitespace-nowrap">
                          {fmt$(run.sale_amount)}
                        </td>
                        <td className="px-3 py-3 text-xs text-slate-400 hidden md:table-cell uppercase">
                          {run.portal || '—'}
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-1.5">
                            <span className={cn('inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full border font-medium', cfg.color)}>
                              <Icon className="w-3 h-3" />
                              {cfg.label}
                            </span>
                            {run.status === 'stopped' && run.stops?.length && (
                              <button onClick={() => toggleStops(run.id)} className="text-slate-500 hover:text-slate-300">
                                {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3">
                          <Button variant="ghost" size="sm" onClick={() => { setSelected(run); setSelectedPortal(''); setActionMsg(null) }}>
                            View
                          </Button>
                        </td>
                      </tr>
                      {expanded && run.stops?.length && (
                        <tr key={`${run.id}-stops`} className="border-b border-slate-800/50 bg-amber-950/10">
                          <td colSpan={6} className="px-4 py-2">
                            {run.stops.map((stop, i) => (
                              <p key={i} className="text-xs text-amber-300 flex items-start gap-1.5 mb-1">
                                <AlertCircle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                                {stop}
                              </p>
                            ))}
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Detail modal */}
      <Modal open={!!selected} onClose={() => setSelected(null)} title="Credit App Details" size="lg">
        {selected && (
          <div className="p-5 space-y-4">
            {/* Status banner */}
            {(() => {
              const cfg = statusConfig(selected.status)
              const Icon = cfg.icon
              return (
                <div className={cn('flex items-center gap-2 px-4 py-3 rounded-xl border text-sm font-medium', cfg.color)}>
                  <Icon className="w-4 h-4" />
                  {cfg.label}
                  {selected.result_summary && <span className="font-normal ml-2 opacity-80">{selected.result_summary}</span>}
                </div>
              )
            })()}

            {/* Stop reasons */}
            {selected.stops?.length ? (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-amber-400 uppercase tracking-wide">Validator Stops</p>
                {selected.stops.map((s, i) => (
                  <div key={i} className="flex items-start gap-2 bg-amber-950/30 border border-amber-800/40 rounded-lg p-3">
                    <AlertCircle className="w-3.5 h-3.5 text-amber-400 mt-0.5 flex-shrink-0" />
                    <p className="text-xs text-amber-200">{s}</p>
                  </div>
                ))}
              </div>
            ) : null}

            {/* Error */}
            {selected.error_message && (
              <div className="flex items-start gap-2 bg-red-950/30 border border-red-800/40 rounded-lg p-3">
                <XCircle className="w-3.5 h-3.5 text-red-400 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-red-200">{selected.error_message}</p>
              </div>
            )}

            {/* Skip reason */}
            {selected.skip_reason && (
              <div className="bg-slate-800 rounded-lg p-3 text-xs text-slate-300">
                <span className="font-medium text-slate-400">Skip reason: </span>{selected.skip_reason}
              </div>
            )}

            <div className="grid grid-cols-2 gap-4 text-sm">
              <div className="space-y-3">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Applicant</p>
                <Field label="Name"        value={selected.applicant_name} />
                <Field label="Co-applicant" value={selected.co_applicant_name} />
                <Field label="Sales Rep"   value={selected.sales_rep} />
                <Field label="Install Date" value={selected.install_date} />
              </div>
              <div className="space-y-3">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Deal</p>
                <Field label="Sale Amount"    value={fmt$(selected.sale_amount)} />
                <Field label="Amt Financed"   value={fmt$(selected.amount_financed)} />
                <Field label="Product"        value={selected.product} />
                <Field label="Promo"          value={selected.promo} />
                <Field label="Lead Source"    value={selected.lead_source} />
                <Field label="Portal"         value={selected.portal?.toUpperCase()} />
              </div>
            </div>

            {selected.email_subject && (
              <div className="border-t border-slate-800 pt-3">
                <p className="text-xs text-slate-500">
                  <span className="font-medium">Email:</span> {selected.email_subject}
                  {selected.email_received_at && (
                    <span className="ml-2 text-slate-600">· {timeAgo(selected.email_received_at)}</span>
                  )}
                </p>
              </div>
            )}

            <p className="text-xs text-slate-600">
              Processed {timeAgo(selected.processed_at)}
            </p>

            {/* Approve / Reject for pending_approval */}
            {selected.status === 'pending_approval' && (
              <div className="border-t border-slate-800 pt-4 space-y-4">
                <p className="text-sm font-semibold text-white">Submit to Finance Portal</p>

                {/* Confirm parsed info */}
                <div className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 space-y-3 text-sm">
                  <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Confirm Parsed Info</p>
                  <div className="grid grid-cols-2 gap-x-6 gap-y-2">
                    <ConfirmField label="Applicant"      value={selected.applicant_name} />
                    <ConfirmField label="Co-Applicant"   value={selected.co_applicant_name} />
                    <ConfirmField label="Sale Amount"    value={fmt$(selected.sale_amount)} />
                    <ConfirmField label="Amt Financed"   value={fmt$(selected.amount_financed)} />
                    <ConfirmField label="Product"        value={selected.product} />
                    <ConfirmField label="Lead Source"    value={selected.lead_source} />
                    <ConfirmField label="Promo / Terms"  value={selected.promo} />
                    <ConfirmField label="Sales Rep"      value={selected.sales_rep} />
                    <ConfirmField label="Install Date"   value={selected.install_date} />
                  </div>
                </div>

                {/* Portal selector */}
                <div className="space-y-1.5">
                  <label className="text-xs text-slate-400 font-medium">Finance Company</label>
                  <select
                    value={selectedPortal || selected.portal || 'ispc'}
                    onChange={e => setSelectedPortal(e.target.value)}
                    className="w-full bg-slate-800 border border-slate-600 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-violet-500"
                  >
                    <option value="ispc">ISPC (default)</option>
                    <option value="foundation">Foundation Finance</option>
                    <option value="synchrony">Synchrony</option>
                    <option value="aquafinance">Aqua Finance (manual approval required)</option>
                  </select>
                  {(selectedPortal || selected.portal) === 'aquafinance' && (
                    <p className="text-xs text-amber-400 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" /> Aqua Finance requires explicit approval — confirm this is intentional.
                    </p>
                  )}
                </div>

                {actionMsg && (
                  <p className={cn('text-sm', actionMsg.startsWith('✅') ? 'text-emerald-400' : 'text-red-400')}>
                    {actionMsg}
                  </p>
                )}

                <div className="flex gap-2">
                  <Button variant="success" size="sm" disabled={approving} onClick={() => approve(selected)}>
                    {approving
                      ? <><Loader2 className="w-3 h-3 animate-spin" /> Submitting…</>
                      : <>✅ Confirm & Submit to {((selectedPortal || selected.portal) || 'ISPC').toUpperCase()}</>}
                  </Button>
                  <Button variant="ghost" size="sm" disabled={approving} onClick={() => reject(selected)}>
                    Reject
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null
  return (
    <div>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-sm text-white">{value}</p>
    </div>
  )
}

function ConfirmField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-xs text-slate-500 w-24 flex-shrink-0">{label}</span>
      <span className={cn('text-sm', value ? 'text-white' : 'text-slate-600 italic')}>{value || 'not provided'}</span>
    </div>
  )
}
