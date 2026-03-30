import { useState, useCallback, useRef } from 'react'
import { Loader2, CheckCircle2, XCircle, AlertCircle, Phone, Mail, MapPin, Droplets, RefreshCw, Edit2, Save, ExternalLink, ChevronDown, ChevronUp } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

interface SmartMailBatch {
  emailId: string
  subject: string
  date: string
  status: 'pdf_ready' | 'processing' | 'done' | 'error'
}

interface SmartMailLead {
  id: number
  batch_id: string
  batch_subject: string
  full_name: string
  address: string | null
  city: string | null
  state: string | null
  zip: string | null
  phone: string | null
  email: string | null
  water_source: string | null
  buys_bottled_water: string | null
  water_conditions: string | null
  water_quality: string | null
  filtration: string | null
  homeowner: string | null
  sample_date: string | null
  house_value: number | null
  house_value_low: number | null
  house_value_high: number | null
  property_owner: string | null
  owner_occupied: boolean | null
  tax_assessed: number | null
  last_sale_date: string | null
  last_sale_price: number | null
  sqft: number | null
  beds: number | null
  baths: number | null
  year_built: number | null
  tds: number | null
  hd: number | null
  ph: number | null
  name_match: boolean | null
  addr_match: boolean | null
  phone_valid: boolean | null
  email_valid: boolean | null
  area_code_match: boolean | null
  brave_snippet: string | null
  confidence: string | null
  sf_lead_id: string | null
  status: string
  page_number: number
  printed_name: string | null
  printed_address: string | null
}

const CONF_STYLE: Record<string, string> = {
  High:   'bg-emerald-950/40 text-emerald-400 border-emerald-800/50',
  Medium: 'bg-yellow-950/40 text-yellow-400 border-yellow-800/50',
  Low:    'bg-orange-950/40 text-orange-400 border-orange-800/50',
  Flag:   'bg-red-950/40 text-red-400 border-red-800/50',
}

function VerBadge({ ok, label }: { ok: boolean | null; label: string }) {
  if (ok === null) return <span className="text-xs text-slate-600">{label} ?</span>
  return (
    <span className={cn('text-xs flex items-center gap-0.5', ok ? 'text-emerald-400' : 'text-red-400')}>
      {ok ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
      {label}
    </span>
  )
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, opts)
  if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error((d as any).error || `HTTP ${r.status}`) }
  return r.json()
}

function LeadCard({ lead: initialLead, batchId, onUpdate }: {
  lead: SmartMailLead
  batchId: string
  onUpdate: (updated: SmartMailLead) => void
}) {
  const [lead, setLead] = useState(initialLead)
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)
  const [edits, setEdits] = useState<Partial<SmartMailLead>>({})
  const [saving, setSaving] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<{ ok: boolean; msg: string } | null>(null)
  const [savedFlash, setSavedFlash] = useState(false)

  const frontPage = lead.page_number
  const backPage = lead.page_number + 1
  const pdfNewTab = `/api/smartmail/pdf/${encodeURIComponent(batchId)}`

  const field = (key: keyof SmartMailLead) =>
    key in edits ? (edits[key] as string) : ((lead[key] as string) ?? '')

  const handleEdit = (key: keyof SmartMailLead, val: string | number | null) =>
    setEdits(prev => ({ ...prev, [key]: val }))

  const saveEdits = async () => {
    if (!Object.keys(edits).length) { setEditing(false); return }
    setSaving(true)
    try {
      const res = await apiFetch<{ ok: boolean; lead: SmartMailLead }>(`/smartmail/lead/${lead.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(edits),
      })
      setLead(res.lead)
      onUpdate(res.lead)
      setEdits({})
      setEditing(false)
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 2000)
    } catch (err) {
      alert('Save failed: ' + (err as Error).message)
    } finally {
      setSaving(false)
    }
  }

  const syncToSF = async () => {
    // Save any pending edits first
    if (Object.keys(edits).length > 0) await saveEdits()
    setSyncing(true)
    setSyncResult(null)
    try {
      const res = await apiFetch<{ ok: boolean; sf_lead_id?: string; error?: string }>(`/smartmail/push-one/${lead.id}`, { method: 'POST' })
      if (res.ok && res.sf_lead_id) {
        const updated = { ...lead, status: 'pushed', sf_lead_id: res.sf_lead_id }
        setLead(updated)
        onUpdate(updated)
        setSyncResult({ ok: true, msg: `✅ Synced to Salesforce` })
      } else {
        setSyncResult({ ok: false, msg: `❌ ${res.error || 'Sync failed'}` })
      }
    } catch (err) {
      setSyncResult({ ok: false, msg: `❌ ${(err as Error).message}` })
    } finally {
      setSyncing(false)
    }
  }

  const inputCls = "w-full bg-slate-800 border border-slate-600 rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-blue-500"

  return (
    <Card className={cn(
      'transition-all',
      lead.status === 'rejected' && 'opacity-40',
      lead.status === 'pushed' && 'border-emerald-800/40',
    )}>
      {/* Header row — always visible */}
      <div
        className="p-4 flex items-center justify-between cursor-pointer select-none"
        onClick={() => setExpanded(e => !e)}
      >
        <div className="flex items-center gap-3">
          <span className="text-xs text-slate-500 w-6">p{lead.page_number}</span>
          <div>
            <p className="text-sm font-semibold text-white">{lead.full_name}</p>
            <p className="text-xs text-slate-500">
              {lead.phone || <span className="text-red-400">No phone</span>}
              {lead.city ? ` · ${lead.city}, ${lead.state}` : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {lead.confidence && (
            <span className={cn('text-xs px-2 py-0.5 rounded-full border font-medium', CONF_STYLE[lead.confidence] || CONF_STYLE.Low)}>
              {lead.confidence}
            </span>
          )}
          {lead.sf_lead_id && (
            <a href={`https://rainsoftse.my.salesforce.com/${lead.sf_lead_id}`}
              target="_blank" rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              className="text-xs text-emerald-400 hover:text-emerald-300">✅ SF
            </a>
          )}
          {lead.status === 'pushed' && !lead.sf_lead_id && (
            <span className="text-xs text-emerald-400">✅ Synced</span>
          )}
          {expanded ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
        </div>
      </div>

      {/* Expanded review panel */}
      {expanded && (
        <div className="border-t border-slate-700/50 p-4 space-y-4">
          {/* Two-column layout: PDF viewer + editable form */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

            {/* Left: Card image viewer (front + back) */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Card (Pages {frontPage}–{backPage})</p>
                <a href={pdfNewTab} target="_blank" rel="noopener noreferrer"
                  className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
                  <ExternalLink className="w-3 h-3" /> Open PDF
                </a>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <p className="text-xs text-slate-500 mb-1 text-center">Front (Survey)</p>
                  <div className="bg-slate-900 border border-slate-700 rounded-lg overflow-hidden" style={{ height: 280 }}>
                    <iframe
                      src={`/api/smartmail/pdf/${encodeURIComponent(batchId)}#page=${frontPage}`}
                      className="w-full h-full"
                      title={`Card front page ${frontPage}`}
                    />
                  </div>
                </div>
                <div>
                  <p className="text-xs text-slate-500 mb-1 text-center">Back (Mailing Label)</p>
                  <div className="bg-slate-900 border border-slate-700 rounded-lg overflow-hidden" style={{ height: 280 }}>
                    <iframe
                      src={`/api/smartmail/pdf/${encodeURIComponent(batchId)}#page=${backPage}`}
                      className="w-full h-full"
                      title={`Card back page ${backPage}`}
                    />
                  </div>
                </div>
              </div>
              {/* Printed label reference */}
              {(lead.printed_name || lead.printed_address) && (
                <div className="bg-slate-800/50 border border-slate-700 rounded px-3 py-2 space-y-0.5">
                  <p className="text-xs text-slate-500 font-medium">Printed label:</p>
                  {lead.printed_name && <p className="text-xs text-slate-300">{lead.printed_name}</p>}
                  {lead.printed_address && <p className="text-xs text-slate-400">{lead.printed_address}</p>}
                </div>
              )}
            </div>

            {/* Right: Editable fields */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Extracted Data</p>
                <div className="flex gap-2">
                  {savedFlash && <span className="text-xs text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" />Saved</span>}
                  {editing ? (
                    <>
                      <Button variant="success" size="sm" onClick={saveEdits} disabled={saving}>
                        {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                        {saving ? 'Saving…' : 'Save'}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setEdits({}) }}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                      <Edit2 className="w-3 h-3" /> Edit
                    </Button>
                  )}
                </div>
              </div>

              {editing ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="col-span-2">
                      <label className="text-xs text-slate-500 mb-0.5 block">Full Name</label>
                      <input className={inputCls} value={field('full_name')} onChange={e => handleEdit('full_name', e.target.value)} />
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 mb-0.5 block">Phone</label>
                      <input className={inputCls} value={field('phone')} onChange={e => handleEdit('phone', e.target.value)} placeholder="334-000-0000" />
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 mb-0.5 block">Email</label>
                      <input className={inputCls} value={field('email')} onChange={e => handleEdit('email', e.target.value)} />
                    </div>
                    <div className="col-span-2">
                      <label className="text-xs text-slate-500 mb-0.5 block">Address</label>
                      <input className={inputCls} value={field('address')} onChange={e => handleEdit('address', e.target.value)} />
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 mb-0.5 block">City</label>
                      <input className={inputCls} value={field('city')} onChange={e => handleEdit('city', e.target.value)} />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="text-xs text-slate-500 mb-0.5 block">State</label>
                        <input className={inputCls} value={field('state')} onChange={e => handleEdit('state', e.target.value)} maxLength={2} />
                      </div>
                      <div>
                        <label className="text-xs text-slate-500 mb-0.5 block">Zip</label>
                        <input className={inputCls} value={field('zip')} onChange={e => handleEdit('zip', e.target.value)} />
                      </div>
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 mb-0.5 block">Homeowner</label>
                      <select className={inputCls} value={field('homeowner')} onChange={e => handleEdit('homeowner', e.target.value)}>
                        <option value="">Unknown</option>
                        <option value="Yes">Yes</option>
                        <option value="No">No</option>
                      </select>
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 mb-0.5 block">TDS (card value)</label>
                      <input className={inputCls} type="number" value={field('tds')} onChange={e => handleEdit('tds', e.target.value ? Number(e.target.value) : null)} />
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 mb-0.5 block">Hardness</label>
                      <input className={inputCls} type="number" value={field('hd')} onChange={e => handleEdit('hd', e.target.value ? Number(e.target.value) : null)} />
                    </div>
                    <div>
                      <label className="text-xs text-slate-500 mb-0.5 block">pH</label>
                      <input className={inputCls} type="number" value={field('ph')} onChange={e => handleEdit('ph', e.target.value ? Number(e.target.value) : null)} />
                    </div>
                  </div>
                </div>
              ) : (
                /* Read-only view */
                <div className="space-y-2">
                  <div className="grid grid-cols-1 gap-1.5 text-xs text-slate-300">
                    {lead.phone ? (
                      <a href={`tel:${lead.phone}`} className="flex items-center gap-1.5 hover:text-blue-400">
                        <Phone className="w-3 h-3 text-slate-500" />{lead.phone}
                      </a>
                    ) : (
                      <span className="flex items-center gap-1.5 text-red-400">
                        <Phone className="w-3 h-3" />No phone — click Edit to add
                      </span>
                    )}
                    {lead.email && (
                      <a href={`mailto:${lead.email}`} className="flex items-center gap-1.5 hover:text-blue-400 truncate">
                        <Mail className="w-3 h-3 text-slate-500" />{lead.email}
                      </a>
                    )}
                    {(lead.address || lead.city) && (
                      <span className="flex items-center gap-1.5">
                        <MapPin className="w-3 h-3 text-slate-500 flex-shrink-0" />
                        {[lead.address, lead.city, lead.state, lead.zip].filter(Boolean).join(', ')}
                      </span>
                    )}
                  </div>

                  {/* Water stats */}
                  <div className="flex flex-wrap gap-2">
                    {lead.tds != null && (
                      <span className="flex items-center gap-1 text-xs bg-blue-950/40 text-blue-300 border border-blue-800/40 px-2 py-0.5 rounded-full"
                        title="Card value → SF value (+100 per business rule)">
                        <Droplets className="w-3 h-3" />TDS {lead.tds} → {lead.tds + 100}
                      </span>
                    )}
                    {lead.hd != null && <span className="text-xs bg-slate-800 text-slate-300 border border-slate-700 px-2 py-0.5 rounded-full">HD {lead.hd}</span>}
                    {lead.ph != null && <span className="text-xs bg-slate-800 text-slate-300 border border-slate-700 px-2 py-0.5 rounded-full">pH {lead.ph}</span>}
                    {lead.water_source && <span className="text-xs bg-slate-800 text-slate-400 border border-slate-700 px-2 py-0.5 rounded-full">{lead.water_source}</span>}
                    {lead.water_quality && (
                      <span className={cn('text-xs px-2 py-0.5 rounded-full border',
                        lead.water_quality === 'Poor' ? 'bg-red-950/30 text-red-400 border-red-800/40' :
                        lead.water_quality === 'Fair' ? 'bg-yellow-950/30 text-yellow-400 border-yellow-800/40' :
                        'bg-emerald-950/30 text-emerald-400 border-emerald-800/40'
                      )}>{lead.water_quality}</span>
                    )}
                    {lead.homeowner && (
                      <span className={cn('text-xs px-2 py-0.5 rounded-full border font-medium',
                        lead.homeowner === 'Yes'
                          ? 'bg-emerald-950/40 text-emerald-400 border-emerald-800/50'
                          : 'bg-amber-950/40 text-amber-400 border-amber-800/50'
                      )}>
                        {lead.homeowner === 'Yes' ? '🏠 Homeowner' : '⚠️ Not Homeowner'}
                      </span>
                    )}
                  </div>

                  {lead.water_conditions && <p className="text-xs text-slate-500">⚠️ {lead.water_conditions}</p>}
                  {lead.filtration && <p className="text-xs text-slate-500">🔧 Filtration: {lead.filtration}</p>}
                </div>
              )}

              {/* Property data from Rentcast */}
              {(lead.property_owner || lead.house_value || lead.tax_assessed) && (
                <div className="bg-slate-800/60 border border-slate-700 rounded-lg px-3 py-2.5 space-y-1.5">
                  {lead.property_owner && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-400 w-24 flex-shrink-0">Record Owner:</span>
                      <span className="text-xs font-medium text-white">{lead.property_owner}</span>
                      {lead.owner_occupied !== null && (
                        <span className={cn('text-xs px-1.5 py-0.5 rounded border',
                          lead.owner_occupied ? 'text-emerald-400 border-emerald-800/50 bg-emerald-950/30' : 'text-amber-400 border-amber-800/50 bg-amber-950/30'
                        )}>
                          {lead.owner_occupied ? 'Owner-Occupied' : 'Not Owner-Occupied'}
                        </span>
                      )}
                    </div>
                  )}
                  {lead.house_value && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs text-slate-400 w-24 flex-shrink-0">Est. Value:</span>
                      <span className="text-sm font-semibold text-white">${lead.house_value.toLocaleString()}</span>
                      {lead.house_value_low && lead.house_value_high && (
                        <span className="text-xs text-slate-500">(${lead.house_value_low.toLocaleString()} – ${lead.house_value_high.toLocaleString()})</span>
                      )}
                    </div>
                  )}
                  {lead.tax_assessed && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-400 w-24 flex-shrink-0">Tax Assessed:</span>
                      <span className="text-xs text-slate-300">${lead.tax_assessed.toLocaleString()}</span>
                    </div>
                  )}
                  {lead.last_sale_price && (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-slate-400 w-24 flex-shrink-0">Last Sale:</span>
                      <span className="text-xs text-slate-300">${lead.last_sale_price.toLocaleString()} {lead.last_sale_date ? `(${lead.last_sale_date.slice(0,10)})` : ''}</span>
                    </div>
                  )}
                  {(lead.sqft || lead.beds || lead.year_built) && (
                    <div className="flex items-center gap-3 text-xs text-slate-500">
                      {lead.beds && <span>{lead.beds} bed</span>}
                      {lead.baths && <span>{lead.baths} bath</span>}
                      {lead.sqft && <span>{lead.sqft.toLocaleString()} sqft</span>}
                      {lead.year_built && <span>Built {lead.year_built}</span>}
                    </div>
                  )}
                </div>
              )}

              {/* Verification badges */}
              <div className="flex flex-wrap gap-3">
                <VerBadge ok={lead.name_match ?? null} label="Name vs label" />
                <VerBadge ok={lead.addr_match ?? null} label="Addr vs label" />
                <VerBadge ok={lead.phone_valid} label="Phone fmt" />
                <VerBadge ok={lead.area_code_match} label="Area code" />
                <VerBadge ok={lead.email_valid} label="Email DNS" />
              </div>
              {lead.brave_snippet && (
                <p className="text-xs text-slate-500 border-l-2 border-slate-700 pl-2">
                  Verification score: <span className="text-white font-medium">{lead.brave_snippet}</span>
                </p>
              )}
            </div>
          </div>

          {/* Action bar */}
          <div className="border-t border-slate-700/50 pt-3 flex items-center justify-between flex-wrap gap-3">
            <div className="flex gap-2 flex-wrap">
              {lead.status !== 'pushed' && (
                <Button variant="primary" size="sm" onClick={syncToSF} disabled={syncing}>
                  {syncing
                    ? <><Loader2 className="w-3 h-3 animate-spin" /> Syncing…</>
                    : <><CheckCircle2 className="w-3 h-3" /> Approve & Sync to Salesforce</>
                  }
                </Button>
              )}
              {lead.status === 'pushed' && lead.sf_lead_id && (
                <a href={`https://rainsoftse.my.salesforce.com/${lead.sf_lead_id}`}
                  target="_blank" rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 text-xs text-emerald-400 hover:text-emerald-300 bg-emerald-950/30 border border-emerald-800/40 rounded-lg px-3 py-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5" /> In Salesforce <ExternalLink className="w-3 h-3" />
                </a>
              )}
              {lead.status !== 'rejected' && lead.status !== 'pushed' && (
                <Button variant="ghost" size="sm"
                  className="text-red-400 hover:text-red-300"
                  onClick={async () => {
                    await apiFetch(`/smartmail/reject/${lead.id}`, { method: 'POST' })
                    const updated = { ...lead, status: 'rejected' }
                    setLead(updated); onUpdate(updated)
                  }}>
                  <XCircle className="w-3 h-3" /> Reject
                </Button>
              )}
            </div>
            {syncResult && (
              <p className={cn('text-xs', syncResult.ok ? 'text-emerald-400' : 'text-red-400')}>
                {syncResult.msg}
              </p>
            )}
          </div>
        </div>
      )}
    </Card>
  )
}

export function SmartMailReview({ batch, onDone }: { batch: SmartMailBatch; onDone?: () => void }) {
  const [processing, setProcessing] = useState(false)
  const [leads, setLeads] = useState<SmartMailLead[]>([])
  const [progress, setProgress] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pushing, setPushing] = useState(false)
  const [pushResult, setPushResult] = useState<string | null>(null)

  const processBatch = useCallback(async () => {
    setProcessing(true)
    setError(null)
    setProgress('Downloading PDF…')
    try {
      setProgress('Sending PDF to Claude for processing…')
      await apiFetch('/smartmail/process-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailId: batch.emailId, subject: batch.subject }),
      })
      setProgress('Processing in background…')
      let attempts = 0
      while (attempts < 24) {
        await new Promise(r => setTimeout(r, 5000))
        attempts++
        const data = await apiFetch<SmartMailLead[]>(`/smartmail/batch/${encodeURIComponent(batch.emailId)}`)
        if (data.length > 0) { setLeads(data); setProgress(''); break }
        setProgress(`Processing… (${attempts * 5}s elapsed)`)
      }
      if (attempts >= 24) setError('Timed out — try refreshing')
    } catch (err) {
      setError((err as Error).message)
      setProgress('')
    } finally {
      setProcessing(false)
    }
  }, [batch])

  const loadLeads = useCallback(async () => {
    try {
      const data = await apiFetch<SmartMailLead[]>(`/smartmail/batch/${encodeURIComponent(batch.emailId)}`)
      setLeads(data)
    } catch {}
  }, [batch.emailId])

  const updateLead = useCallback((updated: SmartMailLead) => {
    setLeads(prev => prev.map(l => l.id === updated.id ? updated : l))
  }, [])

  const pushAllApproved = async () => {
    setPushing(true)
    setPushResult(null)
    try {
      const r = await apiFetch<{ pushed: number; failed: number; results: any[] }>(
        `/smartmail/push-to-sf/${encodeURIComponent(batch.emailId)}`, { method: 'POST' }
      )
      setPushResult(`✅ ${r.pushed} leads pushed to Salesforce${r.failed ? ` (${r.failed} failed)` : ''}`)
      await loadLeads()
      onDone?.()
    } catch (err) {
      setPushResult(`❌ ${(err as Error).message}`)
    } finally {
      setPushing(false)
    }
  }

  // Load existing leads on mount
  const didLoad = useRef(false)
  if (!didLoad.current) {
    didLoad.current = true
    loadLeads()
  }

  const approvedCount = leads.filter(l => l.status === 'approved').length
  const pushedCount = leads.filter(l => l.status === 'pushed').length
  const hasLeads = leads.length > 0

  return (
    <div className="space-y-4">
      {/* Batch header */}
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold text-white">{batch.subject}</p>
          <p className="text-xs text-slate-500">{new Date(batch.date).toLocaleDateString()}</p>
        </div>
        <div className="flex gap-2">
          {hasLeads && (
            <Button variant="ghost" size="sm" onClick={loadLeads}>
              <RefreshCw className="w-3 h-3" />
            </Button>
          )}
          {!hasLeads && !processing && (
            <Button variant="primary" size="sm" onClick={processBatch}>
              Process Batch
            </Button>
          )}
        </div>
      </div>

      {processing && (
        <div className="flex items-center gap-2 text-sm text-blue-400">
          <Loader2 className="w-4 h-4 animate-spin" />
          {progress}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 bg-red-950/40 border border-red-800/40 rounded-xl p-3">
          <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
          <p className="text-sm text-red-300">{error}</p>
        </div>
      )}

      {hasLeads && (
        <>
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <span>{leads.length} leads</span>
            {pushedCount > 0 && <span className="text-emerald-400">· {pushedCount} in Salesforce</span>}
            {approvedCount > 0 && <span className="text-blue-400">· {approvedCount} approved</span>}
            <span>· Click any card to review &amp; edit</span>
          </div>

          <div className="space-y-2">
            {leads.map(lead => (
              <LeadCard
                key={lead.id}
                lead={lead}
                batchId={batch.emailId}
                onUpdate={updateLead}
              />
            ))}
          </div>

          {/* Bulk push approved */}
          {approvedCount > 0 && (
            <div className="pt-2 space-y-2">
              {pushResult && (
                <p className={cn('text-sm', pushResult.startsWith('✅') ? 'text-emerald-400' : 'text-red-400')}>
                  {pushResult}
                </p>
              )}
              <Button variant="primary" size="md" disabled={pushing} onClick={pushAllApproved}>
                {pushing ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Pushing…</> : `Push ${approvedCount} approved lead${approvedCount !== 1 ? 's' : ''} to Salesforce`}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
