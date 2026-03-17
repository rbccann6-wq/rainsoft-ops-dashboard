import { useState, useCallback } from 'react'
import { Loader2, CheckCircle2, XCircle, AlertCircle, Phone, Mail, MapPin, Droplets, RefreshCw } from 'lucide-react'
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
      setProgress('Running OCR on each page (this takes ~30 seconds)…')
      const result = await apiFetch<{ leads: SmartMailLead[]; total: number }>('/smartmail/process-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ emailId: batch.emailId, subject: batch.subject }),
      })
      setLeads(result.leads)
      setProgress('')
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

  const updateStatus = async (id: number, action: 'approve' | 'reject') => {
    await apiFetch(`/smartmail/${action}/${id}`, { method: 'POST' })
    setLeads(prev => prev.map(l => l.id === id ? { ...l, status: action === 'approve' ? 'approved' : 'rejected' } : l))
  }

  const pushToSf = async () => {
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

  const approvedCount = leads.filter(l => l.status === 'approved').length
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

      {/* Progress */}
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

      {/* Leads */}
      {hasLeads && (
        <>
          <p className="text-xs text-slate-500">{leads.length} leads extracted · {approvedCount} approved</p>
          <div className="space-y-3">
            {leads.map(lead => (
              <Card key={lead.id} className={cn(
                lead.status === 'rejected' && 'opacity-40',
                lead.status === 'pushed' && 'border-emerald-800/40'
              )}>
                <div className="p-4 space-y-3">
                  {/* Name + confidence + SF link */}
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-white">{lead.full_name}</p>
                      <p className="text-xs text-slate-500">Page {lead.page_number}</p>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {lead.confidence && (
                        <span className={cn('text-xs px-2 py-0.5 rounded-full border font-medium', CONF_STYLE[lead.confidence] || CONF_STYLE.Low)}>
                          {lead.confidence}
                        </span>
                      )}
                      {lead.sf_lead_id && (
                        <a href={`https://rainsoftse.my.salesforce.com/${lead.sf_lead_id}`} target="_blank" rel="noopener noreferrer"
                          className="text-xs text-emerald-400 hover:text-emerald-300">✅ SF</a>
                      )}
                    </div>
                  </div>

                  {/* Contact info */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 text-xs text-slate-300">
                    {lead.phone && (
                      <a href={`tel:${lead.phone}`} className="flex items-center gap-1.5 hover:text-blue-400">
                        <Phone className="w-3 h-3 text-slate-500" />{lead.phone}
                      </a>
                    )}
                    {lead.email && (
                      <a href={`mailto:${lead.email}`} className="flex items-center gap-1.5 hover:text-blue-400 truncate">
                        <Mail className="w-3 h-3 text-slate-500" />{lead.email}
                      </a>
                    )}
                    {(lead.address || lead.city) && (
                      <span className="flex items-center gap-1.5 sm:col-span-2">
                        <MapPin className="w-3 h-3 text-slate-500 flex-shrink-0" />
                        {[lead.address, lead.city, lead.state, lead.zip].filter(Boolean).join(', ')}
                      </span>
                    )}
                  </div>

                  {/* Homeowner badge */}
                  {lead.homeowner && (
                    <span className={cn('text-xs px-2 py-0.5 rounded-full border font-medium',
                      lead.homeowner === 'Yes'
                        ? 'bg-emerald-950/40 text-emerald-400 border-emerald-800/50'
                        : 'bg-amber-950/40 text-amber-400 border-amber-800/50'
                    )}>
                      {lead.homeowner === 'Yes' ? '🏠 Homeowner' : '⚠️ Not Homeowner'}
                    </span>
                  )}

                  {/* Water stats */}
                  <div className="flex flex-wrap gap-2">
                    {lead.tds != null && (
                      <span className="flex items-center gap-1 text-xs bg-blue-950/40 text-blue-300 border border-blue-800/40 px-2 py-0.5 rounded-full"
                        title={`Card value: ${lead.tds} → SF value: ${lead.tds + 100} (+100 per business rule)`}>
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
                  </div>

                  {/* Conditions + filtration */}
                  {lead.water_conditions && (
                    <p className="text-xs text-slate-500">⚠️ {lead.water_conditions}</p>
                  )}
                  {lead.filtration && (
                    <p className="text-xs text-slate-500">🔧 Filtration: {lead.filtration}</p>
                  )}

                  {/* Verification */}
                  <div className="flex flex-wrap gap-3">
                    <VerBadge ok={lead.name_match ?? null} label="Name vs label" />
                    <VerBadge ok={lead.addr_match ?? null} label="Addr vs label" />
                    <VerBadge ok={lead.phone_valid} label="Phone fmt" />
                    <VerBadge ok={lead.area_code_match} label="Area code" />
                    <VerBadge ok={lead.email_valid} label="Email DNS" />
                  </div>

                  {/* Verification score */}
                  {lead.brave_snippet && (
                    <p className="text-xs text-slate-500 border-l-2 border-slate-700 pl-2">
                      Verification score: <span className="text-white font-medium">{lead.brave_snippet}</span>
                    </p>
                  )}

                  {/* Actions */}
                  {/* Non-homeowner flag */}
                  {lead.status === 'no_homeowner' && (
                    <div className="flex items-center gap-2 bg-amber-950/30 border border-amber-700/40 rounded-lg px-3 py-2">
                      <AlertCircle className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" />
                      <p className="text-xs text-amber-300 font-medium">Not a homeowner — not eligible for Salesforce push</p>
                    </div>
                  )}

                  {lead.status === 'pending' && (
                    <div className="flex gap-2 pt-1">
                      <Button variant="success" size="sm" onClick={() => updateStatus(lead.id, 'approve')}>
                        <CheckCircle2 className="w-3 h-3" /> Approve
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => updateStatus(lead.id, 'reject')}
                        className="text-red-400 hover:text-red-300">
                        <XCircle className="w-3 h-3" /> Reject
                      </Button>
                    </div>
                  )}
                  {lead.status === 'approved' && (
                    <p className="text-xs text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> Approved</p>
                  )}
                  {lead.status === 'pushed' && (
                    <p className="text-xs text-emerald-400 flex items-center gap-1"><CheckCircle2 className="w-3 h-3" /> In Salesforce</p>
                  )}
                </div>
              </Card>
            ))}
          </div>

          {/* Push to SF */}
          {approvedCount > 0 && !leads.every(l => l.status === 'pushed') && (
            <div className="pt-2 space-y-2">
              {pushResult && (
                <p className={cn('text-sm', pushResult.startsWith('✅') ? 'text-emerald-400' : 'text-red-400')}>
                  {pushResult}
                </p>
              )}
              <Button variant="primary" size="md" disabled={pushing} onClick={pushToSf}>
                {pushing ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> Pushing…</> : `Push ${approvedCount} lead${approvedCount !== 1 ? 's' : ''} to Salesforce`}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
