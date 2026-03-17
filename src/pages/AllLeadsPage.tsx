import { useState, useEffect } from 'react'
import { RefreshCw, Loader2, Phone, Mail, MapPin, AlertCircle, Home, DollarSign } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

interface Lead {
  source: 'lowes' | 'smartmail'
  lead_id: string
  full_name: string | null
  phone: string | null
  email: string | null
  address: string | null
  notes: string | null
  status: string | null
  sf_lead_id: string | null
  house_value: number | null
  property_owner: string | null
  created_at: string
  // Extended fields (smartmail)
  water_source?: string | null
  water_quality?: string | null
  water_conditions?: string | null
  tds?: number | null
  hd?: number | null
  ph?: number | null
  homeowner?: string | null
  confidence?: string | null
  name_match?: boolean | null
  addr_match?: boolean | null
  phone_valid?: boolean | null
  area_code_match?: boolean | null
  email_valid?: boolean | null
  last_sale_price?: number | null
  last_sale_date?: string | null
  sqft?: number | null
  beds?: number | null
  baths?: number | null
  year_built?: number | null
}

const SB_URL = 'https://njqavagyuwdmkeyoscbz.supabase.co'
const SB_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5qcWF2YWd5dXdkbWtleW9zY2J6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Mzc1NTM4MywiZXhwIjoyMDg5MzMxMzgzfQ.67pxlJAlqIKgTgDwpoDBcQZ12ezT3ZPbQRXsBnRptPs'

// Module-level cache — never re-fetches on tab switch
let _allLeadsCache: { leads: Lead[]; loadedAt: number } | null = null

async function fetchAllLeads(): Promise<Lead[]> {
  // Fetch both sources in parallel
  const [lowesR, smartR] = await Promise.all([
    fetch(`${SB_URL}/rest/v1/lowes_leads_cache?select=*&order=fetched_at.desc&limit=200`,
      { headers: { Authorization: `Bearer ${SB_KEY}`, apikey: SB_KEY } }),
    fetch(`${SB_URL}/rest/v1/smartmail_leads?select=*&order=processed_at.desc&limit=300&full_name=not.is.null`,
      { headers: { Authorization: `Bearer ${SB_KEY}`, apikey: SB_KEY } }),
  ])
  const [lowes, smart] = await Promise.all([lowesR.json(), smartR.json()])

  const lowesLeads: Lead[] = (Array.isArray(lowes) ? lowes : []).map((r: any) => ({
    source: 'lowes' as const,
    lead_id: r.wo_id,
    full_name: r.customer_name,
    phone: r.phone,
    email: r.email,
    address: r.address,
    notes: r.store,
    status: r.status,
    sf_lead_id: r.sf_lead_id,
    house_value: r.rentcast?.price || null,
    property_owner: r.rentcast?.owner || null,
    created_at: r.fetched_at,
    last_sale_price: r.rentcast?.lastSalePrice || null,
    last_sale_date: r.rentcast?.lastSaleDate || null,
    sqft: r.rentcast?.sqft || null,
    beds: r.rentcast?.beds || null,
    baths: r.rentcast?.baths || null,
    year_built: r.rentcast?.yearBuilt || null,
  }))

  const smartLeads: Lead[] = (Array.isArray(smart) ? smart : []).map((r: any) => ({
    source: 'smartmail' as const,
    lead_id: String(r.id),
    full_name: r.full_name,
    phone: r.phone,
    email: r.email,
    address: [r.address, r.city, r.state, r.zip].filter(Boolean).join(', '),
    notes: r.batch_subject,
    status: r.status,
    sf_lead_id: r.sf_lead_id,
    house_value: r.house_value,
    property_owner: r.property_owner,
    created_at: r.processed_at,
    water_source: r.water_source,
    water_quality: r.water_quality,
    water_conditions: r.water_conditions,
    tds: r.tds,
    hd: r.hd,
    ph: r.ph,
    homeowner: r.homeowner,
    confidence: r.confidence,
    name_match: r.name_match,
    addr_match: r.addr_match,
    phone_valid: r.phone_valid,
    area_code_match: r.area_code_match,
    email_valid: r.email_valid,
    last_sale_price: r.last_sale_price,
    last_sale_date: r.last_sale_date,
    sqft: r.sqft,
    beds: r.beds,
    baths: r.baths,
    year_built: r.year_built,
  }))

  return [...lowesLeads, ...smartLeads].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )
}

const SOURCE_STYLE = {
  lowes:     'bg-blue-950/40 text-blue-300 border-blue-800/50',
  smartmail: 'bg-purple-950/40 text-purple-300 border-purple-800/50',
}

const STATUS_STYLE: Record<string, string> = {
  'Appt Pending':    'text-amber-400',
  'pending':         'text-slate-400',
  'pending_approval':'text-violet-400',
  'approved':        'text-emerald-400',
  'pushed':          'text-emerald-400',
  'rejected':        'text-red-400',
  'no_homeowner':    'text-amber-400',
}

function fmt$(n: number | null) {
  if (!n) return null
  return '$' + Number(n).toLocaleString()
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const d = Math.floor(diff / 86400000)
  const h = Math.floor(diff / 3600000)
  if (d > 0) return `${d}d ago`
  if (h > 0) return `${h}h ago`
  return 'Today'
}

export function AllLeadsPage() {
  const [leads, setLeads]     = useState<Lead[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]     = useState<string | null>(null)
  const [search, setSearch]   = useState('')
  const [filter, setFilter]   = useState<'all' | 'lowes' | 'smartmail'>('all')
  const [expanded, setExpanded] = useState<string | null>(null)

  async function load(force = false) {
    if (!force && _allLeadsCache) {
      setLeads(_allLeadsCache.leads)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const data = await fetchAllLeads()
      _allLeadsCache = { leads: data, loadedAt: Date.now() }
      setLeads(data)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(false) }, [])

  const filtered = leads.filter(l => {
    if (filter !== 'all' && l.source !== filter) return false
    if (search) {
      const q = search.toLowerCase()
      return (l.full_name || '').toLowerCase().includes(q) ||
             (l.address || '').toLowerCase().includes(q) ||
             (l.phone || '').includes(q) ||
             (l.email || '').toLowerCase().includes(q)
    }
    return true
  })

  const lowestCount   = leads.filter(l => l.source === 'lowes').length
  const smartCount    = leads.filter(l => l.source === 'smartmail').length
  const sfCount       = leads.filter(l => l.sf_lead_id).length

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Home className="w-5 h-5 text-blue-400" />
          <h2 className="text-lg font-semibold text-white">All Leads</h2>
          {!loading && (
            <span className="text-xs text-slate-500">
              {leads.length} total · {lowestCount} Lowe's · {smartCount} SmartMail · {sfCount} in SF
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {_allLeadsCache && !loading && (
            <span className="text-xs text-slate-600">loaded {timeAgo(new Date(_allLeadsCache.loadedAt).toISOString())}</span>
          )}
          <Button variant="ghost" size="sm" onClick={() => load(true)} disabled={loading}>
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            Refresh
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search name, address, phone, email…"
          className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-slate-500 outline-none focus:border-blue-500 flex-1 min-w-[200px]"
        />
        {(['all', 'lowes', 'smartmail'] as const).map(f => (
          <button key={f} onClick={() => setFilter(f)}
            className={cn('px-3 py-1.5 text-xs rounded-lg border transition-colors capitalize',
              filter === f ? 'bg-blue-600/20 border-blue-700/50 text-blue-300' : 'border-slate-700 text-slate-400 hover:text-slate-200'
            )}>
            {f === 'lowes' ? "Lowe's" : f === 'smartmail' ? 'SmartMail' : 'All'}
          </button>
        ))}
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-red-950/40 border border-red-700 rounded-xl p-3 text-sm text-red-300">
          <AlertCircle className="w-4 h-4 flex-shrink-0" /> {error}
        </div>
      )}

      {/* Table */}
      <Card>
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading leads…</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-16 text-center text-slate-500 text-sm">No leads found</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="text-left px-4 py-3 text-xs text-slate-500 font-medium">Source</th>
                  <th className="text-left px-3 py-3 text-xs text-slate-500 font-medium">Name</th>
                  <th className="text-left px-3 py-3 text-xs text-slate-500 font-medium hidden md:table-cell">Contact</th>
                  <th className="text-left px-3 py-3 text-xs text-slate-500 font-medium hidden lg:table-cell">Address</th>
                  <th className="text-left px-3 py-3 text-xs text-slate-500 font-medium hidden lg:table-cell">Est. Value</th>
                  <th className="text-left px-3 py-3 text-xs text-slate-500 font-medium">Status</th>
                  <th className="text-left px-3 py-3 text-xs text-slate-500 font-medium w-16">SF</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(lead => (
                  <>
                  <tr key={`${lead.source}-${lead.lead_id}`}
                    onClick={() => setExpanded(expanded === lead.lead_id ? null : lead.lead_id)}
                    className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors cursor-pointer">
                    <td className="px-4 py-3">
                      <span className={cn('text-xs px-2 py-0.5 rounded-full border font-medium', SOURCE_STYLE[lead.source])}>
                        {lead.source === 'lowes' ? "Lowe's" : 'SmartMail'}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <p className="text-sm font-medium text-white">{lead.full_name || '—'}</p>
                      {lead.property_owner && lead.property_owner !== lead.full_name && (
                        <p className="text-xs text-slate-500">Owner: {lead.property_owner}</p>
                      )}
                    </td>
                    <td className="px-3 py-3 hidden md:table-cell">
                      <div className="space-y-0.5">
                        {lead.phone && (
                          <a href={`tel:${lead.phone}`} className="flex items-center gap-1 text-xs text-slate-300 hover:text-blue-400">
                            <Phone className="w-3 h-3 text-slate-500" />{lead.phone}
                          </a>
                        )}
                        {lead.email && (
                          <a href={`mailto:${lead.email}`} className="flex items-center gap-1 text-xs text-blue-400 hover:text-blue-300 truncate max-w-[160px]">
                            <Mail className="w-3 h-3 text-slate-500" />{lead.email}
                          </a>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3 hidden lg:table-cell">
                      {lead.address && (
                        <span className="flex items-center gap-1 text-xs text-slate-400">
                          <MapPin className="w-3 h-3 text-slate-500 flex-shrink-0" />
                          {lead.address}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-3 hidden lg:table-cell">
                      {lead.house_value ? (
                        <span className="flex items-center gap-1 text-xs text-emerald-400">
                          <DollarSign className="w-3 h-3" />{fmt$(lead.house_value)}
                        </span>
                      ) : <span className="text-xs text-slate-600">—</span>}
                    </td>
                    <td className="px-3 py-3">
                      <span className={cn('text-xs', STATUS_STYLE[lead.status || ''] || 'text-slate-400')}>
                        {lead.status || '—'}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      {lead.sf_lead_id ? (
                        <a href={`https://rainsoftse.my.salesforce.com/${lead.sf_lead_id}`}
                          target="_blank" rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-emerald-400 hover:text-emerald-300 font-medium whitespace-nowrap">
                          ✅ SF
                        </a>
                      ) : (
                        <span className="text-xs text-slate-700">—</span>
                      )}
                    </td>
                  </tr>
                  {expanded === lead.lead_id && (
                    <tr key={`${lead.lead_id}-detail`} className="bg-slate-900/60 border-b border-slate-800">
                      <td colSpan={7} className="px-4 py-4">
                        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
                          {/* Contact */}
                          <div className="space-y-1">
                            <p className="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Contact</p>
                            {lead.phone && <p className="text-white"><a href={`tel:${lead.phone}`} className="hover:text-blue-400">{lead.phone}</a></p>}
                            {lead.email && <p className="text-blue-400 truncate"><a href={`mailto:${lead.email}`}>{lead.email}</a></p>}
                            {lead.address && <p className="text-slate-300">{lead.address}</p>}
                          </div>
                          {/* Property */}
                          <div className="space-y-1">
                            <p className="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Property</p>
                            {lead.property_owner && <p className="text-white">{lead.property_owner}</p>}
                            {lead.house_value && <p className="text-emerald-400 font-semibold">{fmt$(lead.house_value)}</p>}
                            {lead.last_sale_price && <p className="text-slate-400">Last sale: {fmt$(lead.last_sale_price)}{lead.last_sale_date ? ` (${lead.last_sale_date.slice(0,10)})` : ''}</p>}
                            {(lead.sqft || lead.beds) && (
                              <p className="text-slate-500">{[lead.beds && `${lead.beds}bd`, lead.baths && `${lead.baths}ba`, lead.sqft && `${lead.sqft.toLocaleString()}sqft`, lead.year_built && `Built ${lead.year_built}`].filter(Boolean).join(' · ')}</p>
                            )}
                          </div>
                          {/* Water data (SmartMail) */}
                          {lead.source === 'smartmail' && (
                            <div className="space-y-1">
                              <p className="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">Water Test</p>
                              {lead.water_source && <p className="text-slate-300">Source: {lead.water_source}</p>}
                              {lead.water_quality && <p className="text-slate-300">Quality: {lead.water_quality}</p>}
                              {lead.tds != null && <p className="text-slate-300">TDS: {lead.tds} → {lead.tds + 100} (SF)</p>}
                              {lead.hd != null && <p className="text-slate-300">HD: {lead.hd}</p>}
                              {lead.ph != null && <p className="text-slate-300">pH: {lead.ph}</p>}
                              {lead.water_conditions && <p className="text-slate-400">{lead.water_conditions}</p>}
                            </div>
                          )}
                          {/* Verification (SmartMail) / Notes (Lowe's) */}
                          <div className="space-y-1">
                            <p className="text-slate-400 font-semibold uppercase tracking-wide text-[10px]">{lead.source === 'smartmail' ? 'Verification' : 'Notes'}</p>
                            {lead.source === 'smartmail' && lead.confidence && (
                              <p className={cn('font-semibold', lead.confidence === 'High' ? 'text-emerald-400' : lead.confidence === 'Medium' ? 'text-yellow-400' : 'text-red-400')}>
                                Confidence: {lead.confidence}
                              </p>
                            )}
                            {lead.source === 'smartmail' && (
                              <div className="flex flex-wrap gap-2">
                                {[
                                  { ok: lead.name_match, label: 'Name' },
                                  { ok: lead.addr_match, label: 'Addr' },
                                  { ok: lead.phone_valid, label: 'Phone' },
                                  { ok: lead.area_code_match, label: 'Area' },
                                  { ok: lead.email_valid, label: 'Email' },
                                ].map(v => (
                                  <span key={v.label} className={cn('text-[10px]', v.ok === true ? 'text-emerald-400' : v.ok === false ? 'text-red-400' : 'text-slate-600')}>
                                    {v.ok === true ? '✅' : v.ok === false ? '❌' : '—'} {v.label}
                                  </span>
                                ))}
                              </div>
                            )}
                            {lead.notes && <p className="text-slate-500 text-[10px]">{lead.notes}</p>}
                            {lead.sf_lead_id && (
                              <a href={`https://rainsoftse.my.salesforce.com/${lead.sf_lead_id}`}
                                target="_blank" rel="noopener noreferrer"
                                className="inline-flex items-center gap-1 text-emerald-400 hover:text-emerald-300 font-medium mt-1">
                                ✅ Open in Salesforce →
                              </a>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  )
}
