import { useState, useEffect, useCallback, useRef } from 'react'
import {
  TrendingUp, RefreshCw, Clock, CheckCircle2, XCircle, AlertCircle,
  ChevronDown, ChevronUp, Search, Filter, BarChart3, FileText, Users
} from 'lucide-react'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

// ─── Types ────────────────────────────────────────────────────────────────────

interface Deal {
  dealId: string
  portal: string
  customerName: string
  submittedDate: string
  assignedUser: string | null
  decision: string | null
  discount: number | null
  fundingRequirements: string | null
  status: string
  lastStatus: string | null
  statusChangedAt: number | null
  docsRequestedAt: number | null
  lastCheckedAt: number | null
  createdAt: number
  updatedAt: number
  saleAmount: number | null
  dealSource: string | null
  salesRep: string | null
  financeAmount: number | null
  buyRate: number | null
  tier: number | null
  fundingDate: string | null
  expDate: string | null
  referenceNumber: string | null
  optionCode: string | null
  coapplicant: string | null
  rescindDate: string | null
  state: string | null
  address: string | null
  phone: string | null
  city: string | null
  zip: string | null
  email: string | null
  saleDate: string | null
  pgNotes: string | null
  pgId: number | null
  docs?: {
    ispcContract: boolean
    merchantPurchase: boolean
    chargeSlip: boolean
    crystalReport: boolean
    fundingReport: boolean
  }
  docsCheckedAt?: string | null
}

interface CustomerGroup {
  name: string
  deals: Deal[]
  portals: string[]
  bestRateDealId: string | null
  bestRate: number | null
  totalAmount: number | null
  hasActive: boolean
}

interface HistoryEntry {
  id: number
  dealId: string
  oldStatus: string | null
  newStatus: string
  changedAt: number
}

interface ComparisonDeal {
  dealId: string
  portal: string
  decision: string | null
  discount: number | null
  status: string
  statusChangedAt: number | null
  submittedDate: string
  isBestRate: boolean
}

interface Comparison {
  customerName: string
  portalCount: number
  bestDealId: string | null
  deals: ComparisonDeal[]
}

interface Stats {
  byPortal: { portal: string; count: number }[]
  byStatus: { status: string; count: number }[]
  activeCount: number
  awaitingDocs: { count: number; oldestAt: number | null }
  staleDocsCount: number
  multiSubmitCount: number
  fundedThisMonth: number
  avgDiscountByPortal: { portal: string; avgDiscount: number; count: number }[]
}

interface PaginationInfo {
  page: number
  limit: number
  total: number
  pages: number
}

// ─── Constants ────────────────────────────────────────────────────────────────

const PORTALS = ['All', 'ISPC', 'Foundation', 'Synchrony', 'Aqua']

const STATUSES = [
  'All',
  'CRD: Review Pending',
  'CRD: In Review',
  'Under Review',
  'Approved',
  'Approved - Need Docs',
  'Approved - In Processing',
  'Declined',
  'Awaiting Docs',
  'Documents Received',
  'Care Call Pending',
  'Fund Me',
  'Funding Pending',
  'Funded',
  'Cancelled',
  'Pending',
  'No Available Offer Found',
  'Application on Hold',
  'Funding On Hold',
]

const PORTAL_COLORS: Record<string, string> = {
  ispc:       'bg-blue-900/60 text-blue-300 border-blue-700',
  foundation: 'bg-emerald-900/60 text-emerald-300 border-emerald-700',
  synchrony:  'bg-purple-900/60 text-purple-300 border-purple-700',
  aqua:       'bg-amber-900/60 text-amber-300 border-amber-700',
}

const STATUS_COLORS: Record<string, string> = {
  'Approved':              'text-emerald-400',
  'Funded':                'text-emerald-300',
  'Fund Me':               'text-emerald-400',
  'Funding Pending':       'text-emerald-400',
  'Declined':              'text-red-400',
  'Application on Hold':   'text-red-300',
  'Funding On Hold':       'text-red-300',
  'Awaiting Docs':         'text-amber-400',
  'Documents Received':    'text-blue-400',
  'CRD: Review Pending':   'text-slate-400',
  'CRD: In Review':        'text-blue-400',
  'Under Review':          'text-blue-400',
  'Care Call Pending':     'text-violet-400',
  'Approved - Need Docs':  'text-amber-400',
  'Approved - In Processing': 'text-blue-400',
  'Cancelled':             'text-red-400',
  'Pending':               'text-slate-400',
  'No Available Offer Found': 'text-red-300',
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function portalBadgeClass(portal: string) {
  return PORTAL_COLORS[portal?.toLowerCase()] ?? 'bg-slate-800 text-slate-300 border-slate-700'
}

function statusColor(status: string) {
  return STATUS_COLORS[status] ?? 'text-slate-400'
}

function timeAgo(epochSec: number | null): string {
  if (!epochSec) return '—'
  const diffMs = Date.now() - epochSec * 1000
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1)  return 'just now'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24)  return `${hrs}h`
  const days = Math.floor(hrs / 24)
  return `${days}d`
}

function fmtDate(dateStr: string | null | undefined): string {
  if (!dateStr) return '—'
  const d = new Date(dateStr)
  if (isNaN(d.getTime())) return dateStr
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function fmtCurrency(n: number | null): string {
  if (n == null) return '—'
  return `$${Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
}

/** Get effective dealer rate (what you keep): 100% minus the lender discount.
 *  For ISPC: no discount listed = 100% approval (no dealer fee). */
function effectiveRate(deal: Deal): number | null {
  const raw = deal.buyRate ?? deal.discount ?? null
  if (raw == null) {
    // ISPC with approved decision but no discount = 100% buy rate
    if (deal.portal?.toLowerCase() === 'ispc' && deal.decision === 'Approved') return 100
    return null
  }
  return Math.round((100 - raw) * 100) / 100
}

/** ISPC risk holdback calculations */
function ispcRiskInfo(deal: Deal): { fundedPct: number; riskAmt: number; fundAmt: number } | null {
  if (deal.portal?.toLowerCase() !== 'ispc' || deal.discount == null || deal.financeAmount == null) return null
  const riskPct = deal.discount / 100
  const riskAmt = Math.round(deal.financeAmount * riskPct)
  const fundAmt = Math.round(deal.financeAmount * (1 - riskPct))
  const fundedPct = Math.round((1 - riskPct) * 100)
  return { fundedPct, riskAmt, fundAmt }
}

/** Parse customer name into { last, first, firstInitial } regardless of format.
 *  "HAWK, C"           → { last: "HAWK", first: "C",           firstInitial: "C" }
 *  "HAWK, CHRISTOPHER"  → { last: "HAWK", first: "CHRISTOPHER", firstInitial: "C" }
 *  "CHRISTOPHER HAWK"   → { last: "HAWK", first: "CHRISTOPHER", firstInitial: "C" }
 */
function parseName(name: string): { last: string; first: string; firstInitial: string } {
  const clean = name.trim().toUpperCase().replace(/\s+/g, ' ')
  // "LAST, FIRST" or "LAST, F" format
  const commaMatch = clean.match(/^([A-Z'-]+)\s*,\s*(.+)$/)
  if (commaMatch) {
    const last = commaMatch[1]
    const first = commaMatch[2].trim()
    return { last, first, firstInitial: first[0] || '' }
  }
  // "FIRST LAST" or "FIRST MIDDLE LAST" format
  const parts = clean.split(' ').filter(Boolean)
  if (parts.length >= 2) {
    const last = parts[parts.length - 1]
    const first = parts.slice(0, -1).join(' ')
    return { last, first, firstInitial: parts[0][0] || '' }
  }
  return { last: clean, first: '', firstInitial: '' }
}

/** Check if two deals likely belong to the same customer.
 *  Match on: last name + first initial (required) + address or amount confirmation.
 *  If address is available on both → must match (street number + street name).
 *  If no address → finance amounts must be within 10% of each other.
 *  Fallback: if only last + initial match AND same state → group them.
 */
function isSameCustomer(a: Deal, b: Deal): boolean {
  const nameA = parseName(a.customerName)
  const nameB = parseName(b.customerName)

  // Last name must match exactly
  if (nameA.last !== nameB.last) return false
  // First initial must match
  if (nameA.firstInitial !== nameB.firstInitial) return false

  // Strongest match: phone number (strip non-digits, compare last 10)
  const phoneA = a.phone?.replace(/\D/g, '').slice(-10)
  const phoneB = b.phone?.replace(/\D/g, '').slice(-10)
  if (phoneA && phoneB && phoneA.length === 10 && phoneB.length === 10) {
    return phoneA === phoneB // Same phone = same person, different phone = different person
  }

  // Strong match: address overlap (normalize and compare street number + name)
  const addrA = a.address?.trim().toUpperCase().replace(/\s+/g, ' ')
  const addrB = b.address?.trim().toUpperCase().replace(/\s+/g, ' ')
  if (addrA && addrB) {
    // Extract street number + first word of street name
    const streetA = addrA.match(/^(\d+\s+\S+)/)
    const streetB = addrB.match(/^(\d+\s+\S+)/)
    if (streetA && streetB) return streetA[1] === streetB[1]
    return addrA === addrB
  }

  // Medium match: finance amount within 10%
  if (a.financeAmount && b.financeAmount) {
    const ratio = Math.min(a.financeAmount, b.financeAmount) / Math.max(a.financeAmount, b.financeAmount)
    if (ratio >= 0.9) return true
  }

  // Weak match: same state confirms it (if available)
  if (a.state && b.state && a.state.toUpperCase() === b.state.toUpperCase()) return true

  // Last resort: last name + first initial match but NO confirming data at all
  // Be conservative — only group if no conflicting signals exist
  // If both have addresses and they don't match → already returned false above
  // If one has no data at all → likely same person (ISPC before app fetch)
  return true
}

/** Group deals by customer using fuzzy matching, compute best rate per group */
function groupByCustomer(deals: Deal[]): CustomerGroup[] {
  // Build groups using union-find style matching
  const groups: Deal[][] = []

  for (const deal of deals) {
    let matched = false
    for (const group of groups) {
      // Check against first deal in group (representative)
      if (isSameCustomer(group[0], deal)) {
        group.push(deal)
        matched = true
        break
      }
    }
    if (!matched) {
      groups.push([deal])
    }
  }

  const result: CustomerGroup[] = []
  for (const groupDeals of groups) {
    // Sort: active first, then by date desc
    groupDeals.sort((a, b) => {
      const aActive = !['Funded', 'Declined', 'Cancelled', 'No Available Offer Found'].includes(a.status)
      const bActive = !['Funded', 'Declined', 'Cancelled', 'No Available Offer Found'].includes(b.status)
      if (aActive !== bActive) return aActive ? -1 : 1
      return (b.submittedDate || '').localeCompare(a.submittedDate || '')
    })

    const portals = [...new Set(groupDeals.map(d => d.portal))]

    // Best rate = highest effective rate (most you keep) among approved deals
    const approved = groupDeals.filter(d =>
      d.decision === 'Approved' && effectiveRate(d) != null
    )
    let bestRateDealId: string | null = null
    let bestRate: number | null = null
    if (approved.length > 0) {
      const best = approved.reduce((a, b) =>
        (effectiveRate(a)! > effectiveRate(b)!) ? a : b
      )
      bestRateDealId = best.dealId
      bestRate = effectiveRate(best)
    }

    const amounts = groupDeals.map(d => d.financeAmount).filter(Boolean) as number[]
    const totalAmount = amounts.length > 0 ? Math.max(...amounts) : null

    const hasActive = groupDeals.some(d =>
      !['Funded', 'Declined', 'Cancelled', 'No Available Offer Found'].includes(d.status)
    )

    // Use the most complete (longest) customer name for display
    const displayName = groupDeals.reduce((a, b) =>
      b.customerName.length > a.customerName.length ? b : a
    ).customerName

    result.push({
      name: displayName,
      deals: groupDeals,
      portals,
      bestRateDealId,
      bestRate,
      totalAmount,
      hasActive,
    })
  }

  // Sort groups: active first, then by most recent submission
  result.sort((a, b) => {
    if (a.hasActive !== b.hasActive) return a.hasActive ? -1 : 1
    const aDate = a.deals[0]?.submittedDate || ''
    const bDate = b.deals[0]?.submittedDate || ''
    return bDate.localeCompare(aDate)
  })

  return result
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatCard({ icon: Icon, label, value, sub, color = 'text-slate-200' }: {
  icon: React.ElementType
  label: string
  value: string | number
  sub?: string
  color?: string
}) {
  return (
    <Card className="flex-1 min-w-0">
      <CardContent className="py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs text-slate-500 mb-1">{label}</p>
            <p className={cn('text-2xl font-bold', color)}>{value}</p>
            {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
          </div>
          <div className="p-2 rounded-lg bg-slate-800 flex-shrink-0">
            <Icon className="w-4 h-4 text-slate-400" />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function PortalBadge({ portal }: { portal: string }) {
  return (
    <span className={cn(
      'inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border',
      portalBadgeClass(portal)
    )}>
      {portal}
    </span>
  )
}

function DecisionBadge({ decision }: { decision: string | null }) {
  if (!decision) return <span className="text-slate-500 text-xs">—</span>
  if (decision === 'Approved') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-emerald-900/60 text-emerald-300 border border-emerald-700">
        <CheckCircle2 className="w-3 h-3" /> Approved
      </span>
    )
  }
  if (decision === 'Declined') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-red-900/60 text-red-300 border border-red-700">
        <XCircle className="w-3 h-3" /> Declined
      </span>
    )
  }
  return <span className="text-slate-400 text-xs">{decision}</span>
}

function ComparisonCard({ comparisons, dealId }: { comparisons: Comparison[]; dealId: string }) {
  const match = comparisons.find(c => c.deals.some(d => d.dealId === dealId))
  if (!match || match.portalCount < 2) return null

  return (
    <div className="mt-3 rounded-lg border border-slate-700 overflow-hidden">
      <div className="bg-slate-800/60 px-4 py-2 border-b border-slate-700">
        <span className="text-xs font-semibold text-slate-300 flex items-center gap-2">
          <BarChart3 className="w-3.5 h-3.5 text-blue-400" />
          {match.customerName} — Rate Comparison
        </span>
      </div>
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-slate-700">
            <th className="text-left px-3 py-2 text-slate-400 font-medium">Portal</th>
            <th className="text-left px-3 py-2 text-slate-400 font-medium">Decision</th>
            <th className="text-left px-3 py-2 text-slate-400 font-medium">Rate</th>
            <th className="text-left px-3 py-2 text-slate-400 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {match.deals.map(d => (
            <tr
              key={d.dealId}
              className={cn(
                'border-b border-slate-700/50 last:border-0',
                d.isBestRate && 'bg-emerald-950/30'
              )}
            >
              <td className="px-3 py-2">
                <div className="flex items-center gap-2">
                  <PortalBadge portal={d.portal} />
                </div>
              </td>
              <td className="px-3 py-2">
                <DecisionBadge decision={d.decision} />
              </td>
              <td className="px-3 py-2">
                <div className="flex items-center gap-1.5">
                  <span className={cn(
                    'font-mono font-semibold',
                    d.isBestRate ? 'text-emerald-300' : 'text-slate-300'
                  )}>
                    {d.discount != null ? `${Math.round((100 - d.discount) * 100) / 100}%` : '—'}
                  </span>
                  {d.isBestRate && (
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-900/60 text-emerald-300 border border-emerald-700">
                      BEST
                    </span>
                  )}
                </div>
              </td>
              <td className="px-3 py-2">
                <span className={statusColor(d.status)}>{d.status}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function HistoryTimeline({ history }: { history: HistoryEntry[] }) {
  if (history.length === 0) {
    return <p className="text-xs text-slate-500 italic mt-2">No status history recorded.</p>
  }

  return (
    <div className="mt-3 space-y-0">
      {history.map((entry, i) => {
        const isLast = i === history.length - 1
        const date = new Date(entry.changedAt * 1000)
        const dateStr = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        const timeStr = date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

        return (
          <div key={entry.id} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div className={cn(
                'w-2.5 h-2.5 rounded-full mt-1 flex-shrink-0 border-2',
                isLast ? 'bg-blue-500 border-blue-400' : 'bg-slate-600 border-slate-500'
              )} />
              {!isLast && <div className="w-px flex-1 bg-slate-700 mt-1 mb-0" style={{ minHeight: 16 }} />}
            </div>
            <div className="pb-3 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                {entry.oldStatus && (
                  <>
                    <span className={cn('text-xs', statusColor(entry.oldStatus))}>{entry.oldStatus}</span>
                    <span className="text-slate-600 text-xs">→</span>
                  </>
                )}
                <span className={cn('text-xs font-medium', statusColor(entry.newStatus))}>{entry.newStatus}</span>
              </div>
              <p className="text-[11px] text-slate-500 mt-0.5">{dateStr} at {timeStr}</p>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function CustomerGroupCard({ group, comparisons }: { group: CustomerGroup; comparisons: Comparison[] }) {
  const [expanded, setExpanded] = useState(group.hasActive)
  const [expandedDealId, setExpandedDealId] = useState<string | null>(null)

  const summaryStatus = group.deals.some(d => d.status === 'Funded') ? 'Funded'
    : group.deals.some(d => d.status === 'Funding Pending') ? 'Funding Pending'
    : group.deals.some(d => ['Awaiting Docs', 'Approved - Need Docs', 'Approved - In Processing'].includes(d.status)) ? 'Awaiting Docs'
    : group.deals.some(d => d.decision === 'Approved') ? 'Approved'
    : group.deals.some(d => d.status === 'Pending' || d.status?.includes('Review')) ? 'Pending'
    : group.deals[0]?.status || '—'

  return (
    <Card className="overflow-hidden">
      {/* Customer header */}
      <div
        onClick={() => setExpanded(v => !v)}
        className={cn(
          'flex items-center gap-3 px-4 py-3 cursor-pointer transition-colors',
          expanded ? 'bg-slate-800/60' : 'hover:bg-slate-800/30'
        )}
      >
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-semibold text-slate-200 text-sm">{group.name}</span>
            {group.deals[0]?.coapplicant && (
              <span className="text-xs text-slate-500">& {group.deals[0].coapplicant}</span>
            )}
            {group.portals.map(p => (
              <PortalBadge key={p} portal={p} />
            ))}
            {group.portals.length > 1 && (
              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-900/60 text-purple-300 border border-purple-700">
                {group.portals.length} PORTALS
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4 flex-shrink-0">
          {group.totalAmount && (
            <span className="text-sm font-mono font-semibold text-slate-300">
              {fmtCurrency(group.totalAmount)}
            </span>
          )}
          {group.bestRate != null && (
            <span className="text-xs font-mono px-2 py-0.5 rounded bg-emerald-900/40 text-emerald-300 border border-emerald-800">
              {group.bestRate}% rate
            </span>
          )}
          <span className={cn('text-xs font-medium whitespace-nowrap', statusColor(summaryStatus))}>
            {summaryStatus}
          </span>
          {expanded
            ? <ChevronUp className="w-4 h-4 text-slate-400" />
            : <ChevronDown className="w-4 h-4 text-slate-500" />
          }
        </div>
      </div>

      {/* Deals table */}
      {expanded && (
        <div className="border-t border-slate-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-800/50">
                <th className="text-left px-4 py-2 text-xs font-medium text-slate-500">Portal</th>
                <th className="text-left px-3 py-2 text-xs font-medium text-slate-500">Decision</th>
                <th className="text-left px-3 py-2 text-xs font-medium text-slate-500">Buy Rate</th>
                <th className="text-left px-3 py-2 text-xs font-medium text-slate-500">Risk Amt</th>
                <th className="text-left px-3 py-2 text-xs font-medium text-slate-500">Fund Amt</th>
                <th className="text-left px-3 py-2 text-xs font-medium text-slate-500">Requested</th>
                <th className="text-left px-3 py-2 text-xs font-medium text-slate-500">Status</th>
                <th className="text-left px-3 py-2 text-xs font-medium text-slate-500">Submitted</th>
                <th className="text-left px-3 py-2 text-xs font-medium text-slate-500">Funded</th>
                <th className="px-3 py-2 w-6"></th>
              </tr>
            </thead>
            <tbody>
              {group.deals.map(deal => {
                const rate = effectiveRate(deal)
                const isBest = deal.dealId === group.bestRateDealId
                const isExp = expandedDealId === deal.dealId
                const risk = ispcRiskInfo(deal)

                return (
                  <>
                    <tr
                      key={deal.dealId}
                      onClick={() => setExpandedDealId(prev => prev === deal.dealId ? null : deal.dealId)}
                      className={cn(
                        'border-b border-slate-800/30 cursor-pointer transition-colors',
                        isBest && 'bg-emerald-950/20',
                        isExp ? 'bg-slate-800/40' : 'hover:bg-slate-800/20'
                      )}
                    >
                      <td className="px-4 py-2">
                        <PortalBadge portal={deal.portal} />
                      </td>
                      <td className="px-3 py-2">
                        <DecisionBadge decision={deal.decision} />
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-1">
                          <span className={cn(
                            'font-mono font-semibold text-sm',
                            risk ? 'text-blue-300' : rate != null ? 'text-emerald-300' : 'text-slate-500'
                          )}>
                            {risk ? `${risk.fundedPct}%` : rate != null ? `${rate}%` : '—'}
                          </span>
                          {isBest && !risk && (
                            <span className="px-1 py-0.5 rounded text-[9px] font-bold bg-emerald-800/60 text-emerald-300 border border-emerald-700 leading-none">
                              BEST
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2 text-xs font-mono">
                        {risk ? (
                          <span className="text-red-400">{fmtCurrency(risk.riskAmt)}</span>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs font-mono">
                        {risk ? (
                          <span className="text-emerald-300">{fmtCurrency(risk.fundAmt)}</span>
                        ) : deal.portal?.toLowerCase() === 'foundation' ? (
                          <span className="text-emerald-300">{fmtCurrency(deal.financeAmount)}</span>
                        ) : (
                          <span className="text-slate-500">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-300 font-mono">
                        {fmtCurrency(deal.financeAmount)}
                      </td>
                      <td className="px-3 py-2">
                        <span className={cn('text-xs whitespace-nowrap', statusColor(deal.status))}>
                          {deal.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-400">
                        {fmtDate(deal.submittedDate)}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-400">
                        {fmtDate(deal.fundingDate)}
                      </td>
                      <td className="px-3 py-2">
                        {isExp
                          ? <ChevronUp className="w-3 h-3 text-slate-400" />
                          : <ChevronDown className="w-3 h-3 text-slate-600" />
                        }
                      </td>
                    </tr>
                    {isExp && (
                      <tr key={`${deal.dealId}-detail`}>
                        <td colSpan={10} className="p-0">
                          <ExpandedRow deal={deal} comparisons={comparisons} />
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
  )
}

function ExpandedRow({ deal, comparisons }: { deal: Deal; comparisons: Comparison[] }) {
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetch(`/api/deal-tracker/history/${deal.dealId}`)
      .then(r => r.json())
      .then(data => {
        setHistory(data.history || [])
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [deal.dealId])

  return (
    <div className="px-4 py-3 bg-slate-900/50 border-t border-slate-800">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Left: deal details + history */}
        <div>
          <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5" /> Status History
          </h4>
          {loading ? (
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <RefreshCw className="w-3 h-3 animate-spin" /> Loading…
            </div>
          ) : (
            <HistoryTimeline history={history} />
          )}
          {/* Deal metadata */}
          <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            {deal.salesRep && (
              <div>
                <span className="text-slate-500">Sales Rep: </span>
                <span className="text-slate-300">{deal.salesRep}</span>
              </div>
            )}
            {deal.saleAmount && (
              <div>
                <span className="text-slate-500">Sale Amount: </span>
                <span className="text-slate-300">{fmtCurrency(deal.saleAmount)}</span>
              </div>
            )}
            {deal.financeAmount && (
              <div>
                <span className="text-slate-500">Finance Amount: </span>
                <span className="text-slate-300">{fmtCurrency(deal.financeAmount)}</span>
              </div>
            )}
            {deal.buyRate != null && (
              <div>
                <span className="text-slate-500">Buy Rate: </span>
                <span className="text-slate-300">{Math.round((100 - deal.buyRate) * 100) / 100}%</span>
              </div>
            )}
            {deal.tier != null && (
              <div>
                <span className="text-slate-500">Tier: </span>
                <span className="text-slate-300">{deal.tier}</span>
              </div>
            )}
            {deal.fundingDate && (
              <div>
                <span className="text-slate-500">Funding Date: </span>
                <span className="text-slate-300">{deal.fundingDate}</span>
              </div>
            )}
            {deal.referenceNumber && (
              <div>
                <span className="text-slate-500">Reference#: </span>
                <span className="text-slate-300 font-mono">{deal.referenceNumber}</span>
              </div>
            )}
            {deal.optionCode && (
              <div>
                <span className="text-slate-500">Option Code: </span>
                <span className="text-slate-300">{deal.optionCode}</span>
              </div>
            )}
            {deal.address && (
              <div className="col-span-2">
                <span className="text-slate-500">Address: </span>
                <span className="text-slate-300">{deal.address}{deal.state ? `, ${deal.state}` : ''}</span>
              </div>
            )}
            {deal.dealSource && (
              <div>
                <span className="text-slate-500">Source: </span>
                <span className="text-slate-300">{deal.dealSource}</span>
              </div>
            )}
            {deal.assignedUser && (
              <div>
                <span className="text-slate-500">Assigned: </span>
                <span className="text-slate-300">{deal.assignedUser}</span>
              </div>
            )}
            {deal.fundingRequirements && (
              <div className="col-span-2">
                <span className="text-slate-500">Funding Req: </span>
                <span className="text-slate-300">{deal.fundingRequirements}</span>
              </div>
            )}
            {deal.pgNotes && (
              <div className="col-span-2">
                <span className="text-slate-500">Notes: </span>
                <span className="text-slate-300">{deal.pgNotes}</span>
              </div>
            )}
          </div>

          {/* Document Status */}
          {deal.portal?.toLowerCase() === 'ispc' && deal.docs && (
            <div className="mt-3">
              <h4 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2 flex items-center gap-1.5">
                <FileText className="w-3.5 h-3.5" /> Documents
              </h4>
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                {[
                  { key: 'ispcContract', label: 'ISPC Contract' },
                  { key: 'merchantPurchase', label: 'Merchant Purchase Agreement' },
                  { key: 'chargeSlip', label: 'Charge Slip' },
                  { key: 'crystalReport', label: 'Crystal Report' },
                  { key: 'fundingReport', label: 'Funding Report' },
                ].map(doc => {
                  const has = deal.docs?.[doc.key as keyof typeof deal.docs] || false
                  return (
                    <div
                      key={doc.key}
                      className={cn(
                        'flex items-center gap-1.5 px-2 py-1.5 rounded-md border text-xs',
                        has
                          ? 'bg-emerald-950/30 border-emerald-800/50 text-emerald-300'
                          : 'bg-slate-800/40 border-slate-700/50 text-slate-500'
                      )}
                    >
                      {has
                        ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 flex-shrink-0" />
                        : <Clock className="w-3.5 h-3.5 text-slate-600 flex-shrink-0" />
                      }
                      <span className="truncate">{doc.label}</span>
                    </div>
                  )
                })}
              </div>
              {deal.docsCheckedAt && (
                <p className="text-[10px] text-slate-600 mt-1">Last checked: {new Date(deal.docsCheckedAt).toLocaleString()}</p>
              )}
            </div>
          )}
        </div>

        {/* Right: comparison card if multi-submitted */}
        <div>
          <ComparisonCard comparisons={comparisons} dealId={deal.dealId} />
        </div>
      </div>
    </div>
  )
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export function DealTrackerPage() {
  const [deals, setDeals] = useState<Deal[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [comparisons, setComparisons] = useState<Comparison[]>([])
  const [pagination, setPagination] = useState<PaginationInfo>({ page: 1, limit: 50, total: 0, pages: 0 })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Filters
  const [portalFilter, setPortalFilter] = useState('All')
  const [statusFilter, setStatusFilter] = useState('All')
  const [search, setSearch] = useState('')
  const [searchInput, setSearchInput] = useState('')

  // UI state
  const [expandedDeal, setExpandedDeal] = useState<string | null>(null)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [showStaleOnly, setShowStaleOnly] = useState(false)
  const [groupMode, setGroupMode] = useState(true)

  const autoRefreshRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const fetchDeals = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ page: '1', limit: '50' })
      if (portalFilter !== 'All') params.set('portal', portalFilter)
      if (statusFilter !== 'All') params.set('status', statusFilter)
      if (search) params.set('search', search)
      if (showStaleOnly) params.set('status', 'Awaiting Docs')

      const [dealsRes, statsRes, compRes] = await Promise.all([
        fetch(`/api/deal-tracker/deals?${params}`),
        fetch('/api/deal-tracker/stats'),
        fetch('/api/deal-tracker/comparison'),
      ])

      if (!dealsRes.ok) throw new Error(`Deals API error: ${dealsRes.status}`)

      const dealsData = await dealsRes.json()
      const statsData = statsRes.ok ? await statsRes.json() : null
      const compData = compRes.ok ? await compRes.json() : { comparisons: [] }

      setDeals(dealsData.deals || [])
      setPagination(dealsData.pagination || { page: 1, limit: 50, total: 0, pages: 0 })
      setStats(statsData)
      setComparisons(compData.comparisons || [])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [portalFilter, statusFilter, search, showStaleOnly])

  useEffect(() => {
    fetchDeals()
  }, [fetchDeals])

  useEffect(() => {
    if (autoRefresh) {
      autoRefreshRef.current = setInterval(fetchDeals, 30000)
    } else {
      if (autoRefreshRef.current) clearInterval(autoRefreshRef.current)
    }
    return () => { if (autoRefreshRef.current) clearInterval(autoRefreshRef.current) }
  }, [autoRefresh, fetchDeals])

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 400)
    return () => clearTimeout(t)
  }, [searchInput])

  // Stale docs alert
  const staleCount = stats?.staleDocsCount ?? 0
  const oldestDocsAge = stats?.awaitingDocs?.oldestAt
    ? timeAgo(stats.awaitingDocs.oldestAt)
    : null

  const toggleExpand = (dealId: string) => {
    setExpandedDeal(prev => prev === dealId ? null : dealId)
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-blue-600/20 border border-blue-700/50">
            <TrendingUp className="w-5 h-5 text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-100">Deal Tracker</h1>
            <p className="text-xs text-slate-500 mt-0.5">Finance portal submissions & rate comparisons</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setGroupMode(v => !v)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors',
              groupMode
                ? 'bg-purple-600/20 text-purple-300 border-purple-700/50'
                : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-200'
            )}
          >
            <Users className="w-3.5 h-3.5" />
            {groupMode ? 'Grouped' : 'Group by Customer'}
          </button>
          <button
            onClick={() => setAutoRefresh(v => !v)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border transition-colors',
              autoRefresh
                ? 'bg-blue-600/20 text-blue-300 border-blue-700/50'
                : 'bg-slate-800 text-slate-400 border-slate-700 hover:text-slate-200'
            )}
          >
            <Clock className="w-3.5 h-3.5" />
            {autoRefresh ? 'Auto (30s)' : 'Auto-refresh'}
          </button>
          <Button
            onClick={fetchDeals}
            disabled={loading}
            variant="secondary"
            size="sm"
          >
            <RefreshCw className={cn('w-3.5 h-3.5 mr-1.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-950/40 border border-red-800/50 text-red-300 text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Stale Docs Banner */}
      {staleCount > 0 && (
        <div className={cn(
          'flex items-center justify-between gap-3 px-4 py-3 rounded-lg border',
          'bg-amber-950/40 border-amber-800/50'
        )}>
          <div className="flex items-center gap-2 text-amber-300 text-sm">
            <AlertCircle className="w-4 h-4 flex-shrink-0" />
            <span>
              ⚠️ <strong>{staleCount}</strong> deal{staleCount !== 1 ? 's' : ''} waiting on signatures for 12+ hours
              {oldestDocsAge && <span className="text-amber-400/70"> (oldest: {oldestDocsAge})</span>}
            </span>
          </div>
          <button
            onClick={() => {
              setStatusFilter('Awaiting Docs')
              setShowStaleOnly(true)
            }}
            className="text-xs px-3 py-1 rounded-md bg-amber-800/40 border border-amber-700/50 text-amber-300 hover:bg-amber-800/60 transition-colors flex-shrink-0"
          >
            View Stale Deals
          </button>
        </div>
      )}

      {/* Stats Row */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard
          icon={BarChart3}
          label="Active Deals"
          value={stats?.activeCount ?? '—'}
          sub="Excluding Funded/Declined"
          color="text-blue-300"
        />
        <StatCard
          icon={Clock}
          label="Awaiting Docs"
          value={stats?.awaitingDocs?.count ?? '—'}
          sub={oldestDocsAge ? `Oldest: ${oldestDocsAge} ago` : undefined}
          color={staleCount > 0 ? 'text-amber-300' : 'text-slate-200'}
        />
        <StatCard
          icon={CheckCircle2}
          label="Funded This Month"
          value={stats?.fundedThisMonth ?? '—'}
          color="text-emerald-300"
        />
        <StatCard
          icon={Users}
          label="Multi-Submit"
          value={stats?.multiSubmitCount ?? '—'}
          sub="Deals at 2+ companies"
          color="text-purple-300"
        />
      </div>

      {/* Filter Bar */}
      <Card>
        <CardContent className="py-3">
          <div className="flex flex-wrap gap-3 items-center">
            <div className="flex items-center gap-1.5 text-slate-400">
              <Filter className="w-3.5 h-3.5" />
              <span className="text-xs font-medium">Filters</span>
            </div>

            {/* Portal */}
            <select
              value={portalFilter}
              onChange={e => { setPortalFilter(e.target.value); setShowStaleOnly(false) }}
              className="bg-slate-800 border border-slate-700 rounded-md text-sm text-slate-300 px-3 py-1.5 focus:outline-none focus:border-blue-600"
            >
              {PORTALS.map(p => <option key={p} value={p}>{p === 'All' ? 'All Portals' : p}</option>)}
            </select>

            {/* Status */}
            <select
              value={statusFilter}
              onChange={e => { setStatusFilter(e.target.value); setShowStaleOnly(false) }}
              className="bg-slate-800 border border-slate-700 rounded-md text-sm text-slate-300 px-3 py-1.5 focus:outline-none focus:border-blue-600"
            >
              {STATUSES.map(s => <option key={s} value={s}>{s === 'All' ? 'All Statuses' : s}</option>)}
            </select>

            {/* Search */}
            <div className="relative flex-1 min-w-[160px] max-w-xs">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500 pointer-events-none" />
              <input
                type="text"
                placeholder="Search customer…"
                value={searchInput}
                onChange={e => setSearchInput(e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 rounded-md text-sm text-slate-300 pl-8 pr-3 py-1.5 focus:outline-none focus:border-blue-600 placeholder:text-slate-600"
              />
            </div>

            {/* Active filter chips */}
            {(portalFilter !== 'All' || statusFilter !== 'All' || search || showStaleOnly) && (
              <button
                onClick={() => {
                  setPortalFilter('All')
                  setStatusFilter('All')
                  setSearch('')
                  setSearchInput('')
                  setShowStaleOnly(false)
                }}
                className="text-xs text-slate-400 hover:text-slate-200 underline"
              >
                Clear filters
              </button>
            )}

            <div className="ml-auto text-xs text-slate-500">
              {pagination.total} deal{pagination.total !== 1 ? 's' : ''}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Main Content — Grouped or Flat */}
      {groupMode ? (
        /* ─── Grouped by Customer ──────────────────────────────── */
        <div className="space-y-3">
          {loading && deals.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-slate-500 text-sm">
                <RefreshCw className="w-5 h-5 animate-spin mx-auto mb-2" />
                Loading deals…
              </CardContent>
            </Card>
          ) : deals.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-slate-500 text-sm">
                No deals found
              </CardContent>
            </Card>
          ) : (
            <>
              <div className="text-xs text-slate-500">
                {deals.length} deals across {groupByCustomer(deals).length} customers
              </div>
              {groupByCustomer(deals).map(group => (
                <CustomerGroupCard key={group.deals.map(d => d.dealId).join('+')} group={group} comparisons={comparisons} />
              ))}
            </>
          )}
        </div>
      ) : (
        /* ─── Flat Table ───────────────────────────────────────── */
        <Card>
          <CardHeader>
            <CardTitle>
              <TrendingUp className="w-4 h-4 text-blue-400" />
              Deals
            </CardTitle>
            <span className="text-xs text-slate-500">
              {loading ? 'Loading…' : `${pagination.total} total`}
            </span>
          </CardHeader>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="text-left px-5 py-3 text-xs font-medium text-slate-400 whitespace-nowrap">Customer</th>
                  <th className="text-left px-3 py-3 text-xs font-medium text-slate-400 whitespace-nowrap">Submitted</th>
                  <th className="text-left px-3 py-3 text-xs font-medium text-slate-400 whitespace-nowrap">Portal</th>
                  <th className="text-left px-3 py-3 text-xs font-medium text-slate-400 whitespace-nowrap">Decision</th>
                  <th className="text-left px-3 py-3 text-xs font-medium text-slate-400 whitespace-nowrap">Buy Rate</th>
                  <th className="text-left px-3 py-3 text-xs font-medium text-slate-400 whitespace-nowrap">Risk Amt</th>
                  <th className="text-left px-3 py-3 text-xs font-medium text-slate-400 whitespace-nowrap">Fund Amt</th>
                  <th className="text-left px-3 py-3 text-xs font-medium text-slate-400 whitespace-nowrap">Requested</th>
                  <th className="text-left px-3 py-3 text-xs font-medium text-slate-400 whitespace-nowrap">Status</th>
                  <th className="text-left px-3 py-3 text-xs font-medium text-slate-400 whitespace-nowrap">In Status</th>
                  <th className="px-3 py-3 w-8"></th>
                </tr>
              </thead>
              <tbody>
                {deals.map(deal => {
                  const isExpanded = expandedDeal === deal.dealId
                  const rate = effectiveRate(deal)
                  const risk = ispcRiskInfo(deal)
                  const isMulti = comparisons.some(c => c.deals.some(d => d.dealId === deal.dealId) && c.portalCount > 1)

                  return (
                    <>
                      <tr
                        key={deal.dealId}
                        onClick={() => toggleExpand(deal.dealId)}
                        className={cn(
                          'border-b border-slate-800/50 cursor-pointer transition-colors',
                          isExpanded ? 'bg-slate-800/40' : 'hover:bg-slate-800/30'
                        )}
                      >
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-slate-200 whitespace-nowrap">
                              {deal.customerName}
                            </span>
                            {isMulti && (
                              <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-purple-900/60 text-purple-300 border border-purple-700">
                                MULTI
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-3 py-3 text-slate-400 text-xs whitespace-nowrap">
                          {fmtDate(deal.submittedDate)}
                        </td>
                        <td className="px-3 py-3">
                          <PortalBadge portal={deal.portal} />
                        </td>
                        <td className="px-3 py-3">
                          <DecisionBadge decision={deal.decision} />
                        </td>
                        <td className="px-3 py-3">
                          <span className={cn(
                            'font-mono font-semibold text-sm',
                            risk ? 'text-blue-300' : rate != null ? 'text-emerald-300' : 'text-slate-500'
                          )}>
                            {risk ? `${risk.fundedPct}%` : rate != null ? `${rate}%` : '—'}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-xs font-mono">
                          {risk ? (
                            <span className="text-red-400">{fmtCurrency(risk.riskAmt)}</span>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-xs font-mono">
                          {risk ? (
                            <span className="text-emerald-300">{fmtCurrency(risk.fundAmt)}</span>
                          ) : deal.portal?.toLowerCase() === 'foundation' ? (
                            <span className="text-emerald-300">{fmtCurrency(deal.financeAmount)}</span>
                          ) : (
                            <span className="text-slate-500">—</span>
                          )}
                        </td>
                        <td className="px-3 py-3 text-xs text-slate-300 font-mono">
                          {fmtCurrency(deal.financeAmount)}
                        </td>
                        <td className="px-3 py-3">
                          <span className={cn('text-xs whitespace-nowrap', statusColor(deal.status))}>
                            {deal.status}
                          </span>
                        </td>
                        <td className="px-3 py-3 text-slate-500 text-xs whitespace-nowrap">
                          {timeAgo(deal.statusChangedAt)}
                        </td>
                        <td className="px-3 py-3">
                          {isExpanded
                            ? <ChevronUp className="w-4 h-4 text-slate-400" />
                            : <ChevronDown className="w-4 h-4 text-slate-500" />
                          }
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr key={`${deal.dealId}-expanded`}>
                          <td colSpan={11} className="p-0">
                            <ExpandedRow deal={deal} comparisons={comparisons} />
                          </td>
                        </tr>
                      )}
                    </>
                  )
                })}
              </tbody>
            </table>
          </div>

          {pagination.pages > 1 && (
            <div className="px-5 py-3 border-t border-slate-800 flex items-center justify-between">
              <span className="text-xs text-slate-500">
                Page {pagination.page} of {pagination.pages}
              </span>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
