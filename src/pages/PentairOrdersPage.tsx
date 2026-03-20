import { useState, useEffect, useCallback } from 'react'
import {
  RefreshCw, Loader2, Package, FileText, DollarSign, TruckIcon,
  AlertCircle, CheckCircle2, Clock, ChevronDown, ChevronRight,
  Download, ExternalLink, Zap, Archive,
} from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

// ── Types ────────────────────────────────────────────────────────────────────

interface OrderItem {
  id: number
  part_id: string
  description: string
  quantity_ordered: number
  quantity_shipped: number
  unit_price: number | null
  line_total: number | null
}

interface Shipment {
  id: number
  packlist_number: string | null
  tracking_number: string | null
  carrier: string | null
  ship_date: string | null
}

interface Invoice {
  id: number
  invoice_number: string
  invoice_date: string | null
  total_due: number | null
  net_after_discount: number | null
  discount_2pct: number | null
  is_credit: boolean
  is_warranty: boolean
}

interface Payment {
  id: number
  amount: number | null
  payment_date: string | null
  status: string
  is_bulk: boolean
}

interface Order {
  id: number
  order_number: string
  order_date: string | null
  desired_ship_date: string | null
  status: string
  customer_name: string | null
  notes: string | null
  items: OrderItem[]
  shipments: Shipment[]
  invoices: Invoice[]
  payments: Payment[]
}

interface ReconciliationRow {
  month: string
  invoice_count: number
  total_invoiced: number
  total_net: number
  total_discount: number
  total_paid: number
  outstanding: number
}

interface Stats {
  totalOrders: number
  totalInvoices: number
  totalInvoiced: number
  totalPaid: number
  outstanding: number
  totalSavings: number
  pollerActive: boolean
  lastPoll: string | null
  lastError: string | null
  recentActivity: ActivityEntry[]
}

interface ActivityEntry {
  type: string
  subject: string
  ts: string
  orderNumber?: string
  trackingNumber?: string
  invoiceNumber?: string
  salesOrder?: string
  amount?: number
  total?: number
  itemCount?: number
  reason?: string
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function fmt$(n: number | null | undefined) {
  if (n == null) return '—'
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })
}

function fmtDate(s: string | null | undefined) {
  if (!s) return '—'
  return new Date(s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmtMonthLabel(yyyyMM: string) {
  const [y, m] = yyyyMM.split('-')
  const d = new Date(parseInt(y), parseInt(m) - 1)
  return d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
}

function trackingUrl(tracking: string | null, carrier: string | null) {
  if (!tracking) return null
  const c = (carrier || '').toUpperCase()
  if (c.includes('UPS'))  return `https://www.ups.com/track?tracknum=${tracking}`
  if (c.includes('SAIA')) return `https://www.saia.com/track/details;PRO=${tracking}`
  return `https://www.ups.com/track?tracknum=${tracking}`
}

function statusColor(status: string) {
  switch (status) {
    case 'paid':      return 'text-emerald-400 bg-emerald-900/30 border-emerald-700/40'
    case 'invoiced':  return 'text-yellow-400 bg-yellow-900/30 border-yellow-700/40'
    case 'shipped':   return 'text-blue-400 bg-blue-900/30 border-blue-700/40'
    case 'ordered':   return 'text-slate-300 bg-slate-800/50 border-slate-700/40'
    case 'partial':   return 'text-orange-400 bg-orange-900/30 border-orange-700/40'
    default:          return 'text-slate-400 bg-slate-800/50 border-slate-700/40'
  }
}

function paymentStatusColor(payments: Payment[], invoices: Invoice[]) {
  if (!invoices.length) return 'text-slate-400'
  if (invoices.every(i => i.is_warranty)) return 'text-slate-400'
  const posted = payments.filter(p => p.status === 'posted')
  if (posted.length) return 'text-emerald-400'
  if (payments.length) return 'text-yellow-400'
  return 'text-red-400'
}

function paymentLabel(payments: Payment[], invoices: Invoice[]) {
  if (!invoices.length) return '—'
  if (invoices.every(i => i.is_warranty)) return 'Warranty'
  const posted = payments.filter(p => p.status === 'posted')
  if (posted.length) return 'Paid'
  if (payments.length) return 'Initiated'
  return 'Unpaid'
}

function activityIcon(type: string) {
  switch (type) {
    case 'order':    return <Package className="w-3.5 h-3.5 text-blue-400" />
    case 'shipment': return <TruckIcon className="w-3.5 h-3.5 text-sky-400" />
    case 'invoice':  return <FileText className="w-3.5 h-3.5 text-yellow-400" />
    case 'payment':  return <DollarSign className="w-3.5 h-3.5 text-emerald-400" />
    default:         return <AlertCircle className="w-3.5 h-3.5 text-slate-400" />
  }
}

// ── Stat Card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value, sub, icon: Icon, color = 'text-white' }: {
  label: string; value: string; sub?: string; icon: React.ElementType; color?: string
}) {
  return (
    <Card className="p-4 bg-slate-900 border-slate-800">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs text-slate-500 uppercase tracking-wider mb-1">{label}</p>
          <p className={cn('text-xl font-bold', color)}>{value}</p>
          {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
        </div>
        <Icon className="w-5 h-5 text-slate-600" />
      </div>
    </Card>
  )
}

// ── Orders Tab ────────────────────────────────────────────────────────────────

function OrdersTab({ orders, onRefresh: _onRefresh }: { orders: Order[]; onRefresh: () => void }) {
  const [filterMonth, setFilterMonth] = useState('')
  const [filterStatus, setFilterStatus] = useState('')
  const [expandedRow, setExpandedRow] = useState<number | null>(null)

  const months = [...new Set(
    orders
      .filter(o => o.order_date)
      .map(o => o.order_date!.substring(0, 7))
  )].sort().reverse()

  const filtered = orders.filter(o => {
    if (filterMonth && (!o.order_date || !o.order_date.startsWith(filterMonth))) return false
    if (filterStatus && o.status !== filterStatus) return false
    return true
  })

  return (
    <div>
      {/* Filters */}
      <div className="flex gap-2 mb-4 flex-wrap">
        <select
          value={filterMonth}
          onChange={e => setFilterMonth(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-300 focus:outline-none"
        >
          <option value="">All months</option>
          {months.map(m => (
            <option key={m} value={m}>{fmtMonthLabel(m)}</option>
          ))}
        </select>
        <select
          value={filterStatus}
          onChange={e => setFilterStatus(e.target.value)}
          className="bg-slate-800 border border-slate-700 rounded px-2 py-1 text-sm text-slate-300 focus:outline-none"
        >
          <option value="">All statuses</option>
          {['ordered', 'shipped', 'invoiced', 'paid', 'partial'].map(s => (
            <option key={s} value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
          ))}
        </select>
        <span className="text-xs text-slate-500 self-center">{filtered.length} orders</span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-slate-800">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/80">
              <th className="text-left px-3 py-2.5 text-slate-400 font-medium">Order #</th>
              <th className="text-left px-3 py-2.5 text-slate-400 font-medium">Date</th>
              <th className="text-left px-3 py-2.5 text-slate-400 font-medium">Items</th>
              <th className="text-left px-3 py-2.5 text-slate-400 font-medium">Status</th>
              <th className="text-left px-3 py-2.5 text-slate-400 font-medium">Tracking</th>
              <th className="text-left px-3 py-2.5 text-slate-400 font-medium">Invoice</th>
              <th className="text-right px-3 py-2.5 text-slate-400 font-medium">Total</th>
              <th className="text-right px-3 py-2.5 text-slate-400 font-medium">Net (2%)</th>
              <th className="text-left px-3 py-2.5 text-slate-400 font-medium">Payment</th>
              <th className="text-left px-3 py-2.5 text-slate-400 font-medium">Paid On</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {filtered.length === 0 && (
              <tr>
                <td colSpan={10} className="px-3 py-8 text-center text-slate-500">
                  No orders found
                </td>
              </tr>
            )}
            {filtered.map(order => {
              const primaryInv = order.invoices[0]
              const primaryShip = order.shipments[0]
              const paidOn = order.payments.find(p => p.status === 'posted')?.payment_date
              const isExpanded = expandedRow === order.id
              const isWarranty = order.invoices.every(i => i.is_warranty)

              return (
                <>
                  <tr
                    key={order.id}
                    className={cn(
                      'hover:bg-slate-800/30 transition-colors cursor-pointer',
                      isWarranty && 'opacity-60'
                    )}
                    onClick={() => setExpandedRow(isExpanded ? null : order.id)}
                  >
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        {isExpanded
                          ? <ChevronDown className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
                          : <ChevronRight className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
                        }
                        <span className="font-mono text-slate-200 text-xs">{order.order_number}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-slate-400 text-xs">{fmtDate(order.order_date)}</td>
                    <td className="px-3 py-2.5">
                      <span className="text-slate-300 text-xs">
                        {order.items.length} {order.items.length === 1 ? 'item' : 'items'}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={cn(
                        'text-xs px-2 py-0.5 rounded border',
                        statusColor(order.status)
                      )}>
                        {order.status}
                      </span>
                    </td>
                    <td className="px-3 py-2.5">
                      {primaryShip?.tracking_number ? (
                        <a
                          href={trackingUrl(primaryShip.tracking_number, primaryShip.carrier) || '#'}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="flex items-center gap-1 text-blue-400 hover:text-blue-300 text-xs font-mono"
                        >
                          {primaryShip.tracking_number.substring(0, 14)}
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      ) : (
                        <span className="text-slate-600 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      {primaryInv ? (
                        <a
                          href={`/api/pentair/invoices/${primaryInv.id}/pdf`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={e => e.stopPropagation()}
                          className="flex items-center gap-1 text-slate-300 hover:text-white text-xs font-mono"
                        >
                          {primaryInv.invoice_number}
                          <Download className="w-3 h-3 text-slate-500" />
                        </a>
                      ) : (
                        <span className="text-slate-600 text-xs">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right text-slate-300 text-xs font-mono">
                      {primaryInv?.is_warranty
                        ? <span className="text-slate-500">$0 warranty</span>
                        : fmt$(primaryInv?.total_due)
                      }
                    </td>
                    <td className="px-3 py-2.5 text-right text-emerald-400 text-xs font-mono">
                      {primaryInv?.is_warranty ? '—' : fmt$(primaryInv?.net_after_discount)}
                    </td>
                    <td className={cn('px-3 py-2.5 text-xs font-medium', paymentStatusColor(order.payments, order.invoices))}>
                      {paymentLabel(order.payments, order.invoices)}
                    </td>
                    <td className="px-3 py-2.5 text-slate-400 text-xs">{fmtDate(paidOn)}</td>
                  </tr>

                  {isExpanded && (
                    <tr key={`${order.id}-expanded`} className="bg-slate-900/60">
                      <td colSpan={10} className="px-6 py-3">
                        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 text-xs">
                          {/* Items */}
                          <div>
                            <p className="text-slate-400 font-medium mb-1.5">Line Items</p>
                            {order.items.length === 0
                              ? <p className="text-slate-600">No items recorded</p>
                              : order.items.map(item => (
                                <div key={item.id} className="flex justify-between py-0.5 text-slate-300">
                                  <span className="font-mono text-slate-400">{item.part_id}</span>
                                  <span className="mx-2 truncate max-w-[120px]">{item.description}</span>
                                  <span>×{item.quantity_ordered}</span>
                                  <span className="ml-2 text-slate-400">{fmt$(item.unit_price)}</span>
                                </div>
                              ))
                            }
                          </div>
                          {/* Shipments */}
                          <div>
                            <p className="text-slate-400 font-medium mb-1.5">Shipments</p>
                            {order.shipments.length === 0
                              ? <p className="text-slate-600">Not yet shipped</p>
                              : order.shipments.map(s => (
                                <div key={s.id} className="py-0.5">
                                  <div className="text-slate-300">{s.carrier} • {fmtDate(s.ship_date)}</div>
                                  {s.tracking_number && (
                                    <a
                                      href={trackingUrl(s.tracking_number, s.carrier) || '#'}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                      className="font-mono text-blue-400 hover:text-blue-300 flex items-center gap-1"
                                    >
                                      {s.tracking_number}
                                      <ExternalLink className="w-3 h-3" />
                                    </a>
                                  )}
                                  {s.packlist_number && (
                                    <div className="text-slate-500">Packlist: {s.packlist_number}</div>
                                  )}
                                </div>
                              ))
                            }
                          </div>
                          {/* Invoices + Payments */}
                          <div>
                            <p className="text-slate-400 font-medium mb-1.5">Invoices & Payments</p>
                            {order.invoices.map(inv => (
                              <div key={inv.id} className="mb-2">
                                <div className="flex items-center gap-2">
                                  <a
                                    href={`/api/pentair/invoices/${inv.id}/pdf`}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="font-mono text-slate-300 hover:text-white flex items-center gap-1"
                                  >
                                    {inv.invoice_number}
                                    <Download className="w-3 h-3 text-slate-500" />
                                  </a>
                                  {inv.is_warranty && <span className="text-slate-500">(warranty)</span>}
                                  {inv.is_credit  && <span className="text-red-400">(credit)</span>}
                                </div>
                                <div className="text-slate-400">
                                  {fmtDate(inv.invoice_date)} • {fmt$(inv.total_due)}
                                  {inv.net_after_discount && (
                                    <span className="text-emerald-400"> → {fmt$(inv.net_after_discount)} (2%)</span>
                                  )}
                                </div>
                              </div>
                            ))}
                            {order.payments.map(p => (
                              <div key={p.id} className="flex items-center gap-2 text-slate-400 mt-1">
                                <CheckCircle2 className={cn('w-3.5 h-3.5', p.status === 'posted' ? 'text-emerald-400' : 'text-yellow-400')} />
                                <span>{fmt$(p.amount)} • {fmtDate(p.payment_date)} • {p.status}</span>
                                {p.is_bulk && <span className="text-slate-500">(bulk)</span>}
                              </div>
                            ))}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Reconciliation Tab ────────────────────────────────────────────────────────

function ReconciliationTab({ data }: { data: ReconciliationRow[] }) {
  const [_expanded, _setExpanded] = useState<string | null>(null)

  if (!data.length) {
    return (
      <div className="text-center py-12 text-slate-500">
        No reconciliation data yet. Run a backfill to import historical invoices.
      </div>
    )
  }

  const totalInvoiced = data.reduce((s, r) => s + Number(r.total_invoiced || 0), 0)
  const totalPaid     = data.reduce((s, r) => s + Number(r.total_paid || 0), 0)
  const totalDiscount = data.reduce((s, r) => s + Number(r.total_discount || 0), 0)

  return (
    <div>
      {/* Totals row */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <Card className="p-3 bg-slate-900 border-slate-800 text-center">
          <p className="text-xs text-slate-500 mb-1">Total Invoiced</p>
          <p className="text-lg font-bold text-white">{fmt$(totalInvoiced)}</p>
        </Card>
        <Card className="p-3 bg-slate-900 border-slate-800 text-center">
          <p className="text-xs text-slate-500 mb-1">Total Paid</p>
          <p className="text-lg font-bold text-emerald-400">{fmt$(totalPaid)}</p>
        </Card>
        <Card className="p-3 bg-slate-900 border-slate-800 text-center">
          <p className="text-xs text-slate-500 mb-1">Discount Saved</p>
          <p className="text-lg font-bold text-blue-400">{fmt$(totalDiscount)}</p>
        </Card>
      </div>

      <div className="rounded-lg border border-slate-800 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-800 bg-slate-900/80">
              <th className="text-left px-3 py-2.5 text-slate-400 font-medium">Month</th>
              <th className="text-right px-3 py-2.5 text-slate-400 font-medium">Invoices</th>
              <th className="text-right px-3 py-2.5 text-slate-400 font-medium">Invoiced</th>
              <th className="text-right px-3 py-2.5 text-slate-400 font-medium">Net (2%)</th>
              <th className="text-right px-3 py-2.5 text-slate-400 font-medium">Paid</th>
              <th className="text-right px-3 py-2.5 text-slate-400 font-medium">Outstanding</th>
              <th className="text-right px-3 py-2.5 text-slate-400 font-medium">% Paid</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {data.map(row => {
              const pct = row.total_invoiced ? Math.round((row.total_paid / row.total_invoiced) * 100) : 0
              return (
                <tr
                  key={row.month}
                  className="hover:bg-slate-800/30 transition-colors"
                >
                  <td className="px-3 py-2.5 text-slate-200 font-medium">{fmtMonthLabel(row.month)}</td>
                  <td className="px-3 py-2.5 text-right text-slate-400">{row.invoice_count}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-slate-300">{fmt$(row.total_invoiced)}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-emerald-400">{fmt$(row.total_net)}</td>
                  <td className="px-3 py-2.5 text-right font-mono text-emerald-300">{fmt$(row.total_paid)}</td>
                  <td className={cn(
                    'px-3 py-2.5 text-right font-mono',
                    Number(row.outstanding) > 0 ? 'text-red-400' : 'text-slate-500'
                  )}>
                    {fmt$(row.outstanding)}
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 bg-slate-800 rounded-full h-1.5">
                        <div
                          className={cn(
                            'h-1.5 rounded-full',
                            pct >= 100 ? 'bg-emerald-500' : pct >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                          )}
                          style={{ width: `${Math.min(100, pct)}%` }}
                        />
                      </div>
                      <span className={cn(
                        'text-xs',
                        pct >= 100 ? 'text-emerald-400' : pct >= 50 ? 'text-yellow-400' : 'text-red-400'
                      )}>
                        {pct}%
                      </span>
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ── Activity Tab ──────────────────────────────────────────────────────────────

function ActivityTab({ activity }: { activity: ActivityEntry[] }) {
  if (!activity.length) {
    return (
      <div className="text-center py-12 text-slate-500">
        No recent activity. Emails are polled every 5 minutes.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {activity.map((a, i) => (
        <div key={i} className="flex items-start gap-3 p-3 rounded-lg bg-slate-900 border border-slate-800">
          <div className="mt-0.5">{activityIcon(a.type)}</div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-slate-300 truncate">{a.subject}</p>
              <span className="text-xs text-slate-600 flex-shrink-0">
                {new Date(a.ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}
              </span>
            </div>
            <div className="flex gap-3 mt-0.5 text-xs text-slate-500 flex-wrap">
              {a.orderNumber   && <span>Order: {a.orderNumber}</span>}
              {a.invoiceNumber && <span>Inv: {a.invoiceNumber}</span>}
              {a.trackingNumber && <span>Tracking: {a.trackingNumber}</span>}
              {a.salesOrder    && <span>SO: {a.salesOrder}</span>}
              {a.amount        != null && <span>Amount: {fmt$(a.amount)}</span>}
              {a.total         != null && <span>Total: {fmt$(a.total)}</span>}
              {a.itemCount     != null && <span>{a.itemCount} items</span>}
              {a.reason        && <span className="text-red-400">{a.reason}</span>}
            </div>
          </div>
          <span className={cn(
            'text-xs px-1.5 py-0.5 rounded border flex-shrink-0',
            a.type === 'order'    && 'bg-blue-900/30 text-blue-400 border-blue-700/40',
            a.type === 'shipment' && 'bg-sky-900/30 text-sky-400 border-sky-700/40',
            a.type === 'invoice'  && 'bg-yellow-900/30 text-yellow-400 border-yellow-700/40',
            a.type === 'payment'  && 'bg-emerald-900/30 text-emerald-400 border-emerald-700/40',
            a.type === 'invoice_skip' && 'bg-red-900/30 text-red-400 border-red-700/40',
          )}>
            {a.type.replace('_', ' ')}
          </span>
        </div>
      ))}
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function PentairOrdersPage() {
  const [tab, setTab]           = useState<'orders' | 'reconciliation' | 'activity'>('orders')
  const [stats, setStats]       = useState<Stats | null>(null)
  const [orders, setOrders]     = useState<Order[]>([])
  const [recon, setRecon]       = useState<ReconciliationRow[]>([])
  const [loading, setLoading]   = useState(true)
  const [polling, setPolling]   = useState(false)
  const [backfilling, setBackfilling] = useState(false)
  const [error, setError]       = useState<string | null>(null)

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [statsR, ordersR, reconR] = await Promise.all([
        fetch('/api/pentair/stats').then(r => r.json()),
        fetch('/api/pentair/orders').then(r => r.json()),
        fetch('/api/pentair/reconciliation').then(r => r.json()),
      ])
      setStats(statsR)
      setOrders(Array.isArray(ordersR) ? ordersR : [])
      setRecon(Array.isArray(reconR) ? reconR : [])
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  const handlePoll = async () => {
    setPolling(true)
    try {
      await fetch('/api/pentair/poll', { method: 'POST' })
      await loadAll()
    } catch {}
    setPolling(false)
  }

  const handleBackfill = async () => {
    if (!confirm('Run a one-time backfill of Pentair emails from the last 90 days? This may take a minute.')) return
    setBackfilling(true)
    try {
      const r = await fetch('/api/pentair/backfill', { method: 'POST' })
      const data = await r.json()
      alert(`Backfill complete: ${data.processed} emails processed`)
      await loadAll()
    } catch (err: any) {
      alert(`Backfill failed: ${err.message}`)
    }
    setBackfilling(false)
  }

  const tabs = [
    { id: 'orders' as const, label: 'Orders', count: orders.length },
    { id: 'reconciliation' as const, label: 'Reconciliation', count: recon.length },
    { id: 'activity' as const, label: 'Recent Activity', count: stats?.recentActivity?.length || 0 },
  ]

  return (
    <div className="max-w-[1400px] mx-auto space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">Pentair Orders & Inventory</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {stats?.pollerActive
              ? `Polling every 5 min · Last check ${stats.lastPoll ? new Date(stats.lastPoll).toLocaleTimeString() : 'never'}`
              : 'Poller inactive'
            }
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleBackfill}
            disabled={backfilling}
            className="text-slate-400 hover:text-slate-200 text-xs"
          >
            {backfilling ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Archive className="w-3.5 h-3.5 mr-1" />}
            Backfill 90d
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={handlePoll}
            disabled={polling}
            className="text-slate-400 hover:text-slate-200 text-xs"
          >
            {polling ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Zap className="w-3.5 h-3.5 mr-1" />}
            Poll Now
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={loadAll}
            disabled={loading}
            className="text-slate-400 hover:text-slate-200"
          >
            <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          </Button>
        </div>
      </div>

      {/* Error banner */}
      {(error || stats?.lastError) && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-900/20 border border-red-800/40 text-red-400 text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error || stats?.lastError}
        </div>
      )}

      {/* Stats bar */}
      {loading && !stats ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="w-6 h-6 animate-spin text-slate-600" />
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <StatCard
            label="Total Orders"
            value={String(stats?.totalOrders ?? 0)}
            icon={Package}
          />
          <StatCard
            label="Total Invoiced"
            value={fmt$(stats?.totalInvoiced ?? 0)}
            sub={`${stats?.totalInvoices ?? 0} invoices`}
            icon={FileText}
            color="text-white"
          />
          <StatCard
            label="Total Paid"
            value={fmt$(stats?.totalPaid ?? 0)}
            icon={CheckCircle2}
            color="text-emerald-400"
          />
          <StatCard
            label="Outstanding"
            value={fmt$(stats?.outstanding ?? 0)}
            icon={Clock}
            color={(stats?.outstanding ?? 0) > 0 ? 'text-red-400' : 'text-slate-400'}
          />
          <StatCard
            label="2% Discount Saved"
            value={fmt$(stats?.totalSavings ?? 0)}
            icon={DollarSign}
            color="text-blue-400"
          />
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-slate-800">
        <div className="flex gap-0">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'px-4 py-2.5 text-sm font-medium border-b-2 transition-colors',
                tab === t.id
                  ? 'border-blue-500 text-blue-400'
                  : 'border-transparent text-slate-500 hover:text-slate-300'
              )}
            >
              {t.label}
              {t.count > 0 && (
                <span className={cn(
                  'ml-1.5 text-xs px-1.5 py-0.5 rounded-full',
                  tab === t.id ? 'bg-blue-900/60 text-blue-300' : 'bg-slate-800 text-slate-500'
                )}>
                  {t.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      <div>
        {tab === 'orders' && (
          <OrdersTab orders={orders} onRefresh={loadAll} />
        )}
        {tab === 'reconciliation' && (
          <ReconciliationTab data={recon} />
        )}
        {tab === 'activity' && (
          <ActivityTab activity={stats?.recentActivity ?? []} />
        )}
      </div>
    </div>
  )
}
