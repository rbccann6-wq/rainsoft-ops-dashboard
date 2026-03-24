import { useState, useEffect, useCallback, useRef } from 'react'
import { Target, RefreshCw, Loader2, Phone, MapPin, Store, AlertCircle, CheckCircle2, Upload, Download } from 'lucide-react'
import type { ImeLead, SmartMailBatch } from '@/types'
import { fetchImeLeads, fetchSmartMailBatches, exportLeadToCrm, exportAllToCrm } from '@/lib/leadsApi'
import { SmartMailReview } from './SmartMailReview'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

// ── SmartMail tab: shows existing processed leads + new unprocessed batches ──
function SmartMailTab({ batches, onRefresh }: { batches: SmartMailBatch[]; onRefresh: () => void }) {
  const [existingLeads, setExistingLeads] = useState<any[]>([])
  const [loadingLeads, setLoadingLeads] = useState(true)

  useEffect(() => {
    fetch('/api/smartmail/all-pending')
      .then(r => r.json())
      .then(d => { setExistingLeads(d.leads || []); setLoadingLeads(false) })
      .catch(() => setLoadingLeads(false))
  }, [])

  const batchIds = new Set(existingLeads.map((l: any) => l.batch_id))
  const newBatches = batches.filter(b => !batchIds.has(b.emailId))

  // Group existing leads by batch
  const byBatch: Record<string, { subject: string; emailId: string; leads: any[] }> = {}
  for (const lead of existingLeads) {
    if (!byBatch[lead.batch_id]) {
      byBatch[lead.batch_id] = { subject: lead.batch_subject, emailId: lead.batch_id, leads: [] }
    }
    byBatch[lead.batch_id].leads.push(lead)
  }

  return (
    <div className="space-y-4">
      {/* Existing processed leads grouped by batch */}
      {loadingLeads && (
        <div className="flex items-center gap-2 text-slate-500 text-sm py-4">
          <Loader2 className="w-4 h-4 animate-spin" /> Loading leads…
        </div>
      )}

      {!loadingLeads && Object.values(byBatch).map(group => (
        <Card key={group.emailId}>
          <div className="p-4">
            <SmartMailReview
              batch={{ emailId: group.emailId, subject: group.subject, date: '', status: 'done' }}
              onDone={onRefresh}
            />
          </div>
        </Card>
      ))}

      {/* New unprocessed batches */}
      {newBatches.length > 0 && (
        <>
          <p className="text-xs text-slate-500 font-medium uppercase tracking-wide pt-2">New Unprocessed Batches</p>
          {newBatches.map(batch => (
            <Card key={batch.emailId}>
              <div className="p-4">
                <SmartMailReview batch={batch} onDone={onRefresh} />
              </div>
            </Card>
          ))}
        </>
      )}

      {!loadingLeads && Object.keys(byBatch).length === 0 && newBatches.length === 0 && (
        <p className="text-sm text-slate-500 py-8 text-center">No SmartMail leads found.</p>
      )}
    </div>
  )
}

// Module-level cache — survives tab switching, cleared only on explicit Refresh
let _leadsCache: { leads: ImeLead[]; batches: SmartMailBatch[]; loadedAt: number } | null = null
const CHECK_INTERVAL_MS = 30 * 60 * 1000  // 30 min background check

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const h = Math.floor(diff / 3600000)
  const d = Math.floor(diff / 86400000)
  if (d > 0) return `${d}d ago`
  if (h > 0) return `${h}h ago`
  return 'Just now'
}

type ExportState = 'idle' | 'exporting' | 'done' | 'error'

export function LeadsPanel() {
  const [imeLeads, setImeLeads] = useState<ImeLead[]>([])
  const [smartBatches, setSmartBatches] = useState<SmartMailBatch[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [contacted, setContacted] = useState<Set<string>>(new Set())
  const [exportStates, setExportStates] = useState<Record<string, ExportState>>({})
  const [bulkExporting, setBulkExporting] = useState(false)
  const [bulkResult, setBulkResult] = useState<{ exported: number; errors: number } | null>(null)
  const [activeTab, setActiveTab] = useState<'lowes' | 'smartmail'>('lowes')
  const [newLeadCount, setNewLeadCount] = useState(0)
  const checkIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const loadAll = useCallback(async (forceRefresh = false) => {
    // Use cache if available and not forcing refresh
    if (!forceRefresh && _leadsCache) {
      setImeLeads(_leadsCache.leads)
      setSmartBatches(_leadsCache.batches)
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    try {
      const [imeData, smartData] = await Promise.all([
        fetchImeLeads(),
        fetchSmartMailBatches(),
      ])
      _leadsCache = { leads: imeData.leads, batches: smartData, loadedAt: Date.now() }
      setImeLeads(imeData.leads)
      setSmartBatches(smartData)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  // Background check — only fetches WO numbers from cached email headers, no Rentcast
  const checkForNewLeads = useCallback(async () => {
    if (!_leadsCache) return
    try {
      const r = await fetch('/api/leads/check-new')
      if (!r.ok) return
      const { newCount } = await r.json()
      if (newCount > 0) setNewLeadCount(newCount)
    } catch { /* silent — background check */ }
  }, [])

  // Load on mount — uses cache if available, no re-fetch on tab switch
  useEffect(() => { loadAll(false) }, [loadAll])

  // Start background check every 30 min
  useEffect(() => {
    checkIntervalRef.current = setInterval(checkForNewLeads, CHECK_INTERVAL_MS)
    return () => {
      if (checkIntervalRef.current) clearInterval(checkIntervalRef.current)
    }
  }, [checkForNewLeads])

  // Only show leads not yet in Salesforce — once synced they move to All Leads tab
  const pendingLeads = imeLeads.filter(l => !l.sfLeadId)
  const pendingCount = pendingLeads.filter(l => !contacted.has(l.woId)).length

  async function handleExportOne(lead: ImeLead) {
    setExportStates(s => ({ ...s, [lead.woId]: 'exporting' }))
    try {
      await exportLeadToCrm(lead)
      setExportStates(s => ({ ...s, [lead.woId]: 'done' }))
    } catch {
      setExportStates(s => ({ ...s, [lead.woId]: 'error' }))
    }
  }

  async function handleExportAll() {
    setBulkExporting(true)
    setBulkResult(null)
    try {
      const result = await exportAllToCrm(imeLeads)
      setBulkResult(result)
      // Mark all exported successfully as 'done'
      const updates: Record<string, ExportState> = {}
      imeLeads.forEach(l => { updates[l.woId] = 'done' })
      setExportStates(s => ({ ...s, ...updates }))
    } catch (err) {
      setBulkResult({ exported: 0, errors: imeLeads.length })
    } finally {
      setBulkExporting(false)
    }
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Target className="w-5 h-5 text-blue-400" />
          <h2 className="text-lg font-semibold text-white">Leads</h2>
          {pendingCount > 0 && (
            <Badge variant="unread">{pendingCount} pending</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {activeTab === 'lowes' && imeLeads.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleExportAll}
              disabled={bulkExporting}
              title="Export all leads to CRM"
            >
              {bulkExporting
                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                : <Download className="w-3.5 h-3.5" />
              }
              <span className="hidden sm:inline">Export All to CRM</span>
            </Button>
          )}
          {_leadsCache && !loading && (
            <span className="text-xs text-slate-600 hidden sm:inline">
              loaded {timeAgo(new Date(_leadsCache.loadedAt).toISOString())}
            </span>
          )}
          <Button variant="ghost" size="sm" onClick={() => { loadAll(true) }} disabled={loading}>
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      {/* Error state */}
      {/* New leads banner */}
      {newLeadCount > 0 && (
        <button
          onClick={() => { setNewLeadCount(0); loadAll(true) }}
          className="w-full flex items-center justify-between gap-3 bg-blue-950/40 border border-blue-700/60 rounded-xl px-4 py-3 text-sm text-blue-300 hover:bg-blue-950/60 transition-colors"
        >
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
            <span className="font-medium">{newLeadCount} new Lowe's lead{newLeadCount !== 1 ? 's' : ''} available</span>
          </div>
          <span className="text-xs text-blue-400">Click to load →</span>
        </button>
      )}

      {error && (
        <div className="flex items-start gap-3 bg-red-950/40 border border-red-700 rounded-xl p-4">
          <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-red-300">Failed to load leads</p>
            <p className="text-xs text-slate-400 mt-0.5">{error}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={() => { loadAll(true) }} className="ml-auto">Retry</Button>
        </div>
      )}

      {/* Bulk export result */}
      {bulkResult && (
        <div className={cn(
          'flex items-center gap-3 rounded-xl p-3 border text-sm',
          bulkResult.errors === 0
            ? 'bg-green-950/30 border-green-700/50 text-green-300'
            : 'bg-amber-950/30 border-amber-700/50 text-amber-300'
        )}>
          {bulkResult.errors === 0
            ? `✅ All ${bulkResult.exported} leads exported to CRM`
            : `⚠️ ${bulkResult.exported} exported, ${bulkResult.errors} failed`
          }
          <button onClick={() => setBulkResult(null)} className="ml-auto text-slate-500 hover:text-slate-300 text-xs">Dismiss</button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-800">
        {(['lowes', 'smartmail'] as const).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 transition-colors',
              activeTab === tab
                ? 'border-blue-500 text-white'
                : 'border-transparent text-slate-400 hover:text-slate-300'
            )}
          >
            {tab === 'lowes' ? "Lowe's (IME)" : 'SmartMail Cards'}
            {tab === 'lowes' && imeLeads.length > 0 && (
              <span className="ml-2 text-xs bg-blue-900/50 text-blue-300 px-1.5 py-0.5 rounded-full">
                {pendingLeads.length}
              </span>
            )}
            {tab === 'smartmail' && smartBatches.length > 0 && (
              <span className="ml-2 text-xs bg-blue-900/50 text-blue-300 px-1.5 py-0.5 rounded-full">
                {smartBatches.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading leads…</span>
        </div>
      )}

      {/* Lowe's IME Leads */}
      {!loading && activeTab === 'lowes' && (
        <div className="space-y-3">
          {pendingLeads.length === 0 && !error && (
            <p className="text-sm text-slate-500 py-8 text-center">No pending Lowe's leads — all synced to Salesforce. View them in the <strong className="text-slate-300">All Leads</strong> tab.</p>
          )}
          {pendingLeads.map(lead => {
            const exportState = exportStates[lead.woId] ?? 'idle'
            return (
              <Card key={lead.woId} className={cn(contacted.has(lead.woId) && 'opacity-60')}>
                <div className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-white">{lead.customerName}</p>
                      <div className="flex items-center gap-2">
                        <p className="text-xs text-slate-500">WO #{lead.woId} · {timeAgo(lead.emailDate)}</p>
                        {lead.sfLeadId && (
                          <a
                            href={`https://rainsoftse.my.salesforce.com/${lead.sfLeadId}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-emerald-400 hover:text-emerald-300 flex items-center gap-1"
                            title="Open in Salesforce"
                          >
                            ✅ SF
                          </a>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {exportState === 'done' && (
                        <span className="text-xs text-green-400 flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> In CRM
                        </span>
                      )}
                      {exportState === 'error' && (
                        <span className="text-xs text-red-400">Export failed</span>
                      )}
                      <Badge variant={contacted.has(lead.woId) ? 'read' : 'unread'}>
                        {contacted.has(lead.woId) ? 'Contacted' : lead.status}
                      </Badge>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs text-slate-300">
                    {lead.phone && (
                      <a href={`tel:${lead.phone}`} className="flex items-center gap-2 hover:text-blue-400 transition-colors">
                        <Phone className="w-3 h-3 text-slate-500 flex-shrink-0" />
                        {lead.phone}
                        {lead.officePhone && <span className="text-slate-500">/ {lead.officePhone}</span>}
                      </a>
                    )}
                    {lead.address && (
                      <span className="flex items-center gap-2">
                        <MapPin className="w-3 h-3 text-slate-500 flex-shrink-0" />
                        {lead.address}
                      </span>
                    )}
                    {lead.store && (
                      <span className="flex items-center gap-2 sm:col-span-2">
                        <Store className="w-3 h-3 text-slate-500 flex-shrink-0" />
                        {lead.store}
                      </span>
                    )}
                    {lead.email && (
                      <a href={`mailto:${lead.email}`} className="text-blue-400 hover:text-blue-300 sm:col-span-2">
                        {lead.email}
                      </a>
                    )}
                  </div>

                  {/* Property data from Rentcast */}
                  {lead.rentcast && (lead.rentcast.price || lead.rentcast.owner) && (
                    <div className="bg-slate-800/60 border border-slate-700 rounded-lg px-3 py-2 space-y-1 text-xs">
                      {lead.rentcast.owner && (
                        <div className="flex items-center gap-2">
                          <span className="text-slate-400 w-20 flex-shrink-0">Owner:</span>
                          <span className="text-white font-medium">{lead.rentcast.owner}</span>
                          {lead.rentcast.ownerOccupied !== null && (
                            <span className={lead.rentcast.ownerOccupied ? 'text-emerald-400' : 'text-amber-400'}>
                              {lead.rentcast.ownerOccupied ? '· Owner-Occupied' : '· Not Owner-Occupied'}
                            </span>
                          )}
                        </div>
                      )}
                      {lead.rentcast.price && (
                        <div className="flex items-center gap-2">
                          <span className="text-slate-400 w-20 flex-shrink-0">Est. Value:</span>
                          <span className="text-white font-semibold">${lead.rentcast.price.toLocaleString()}</span>
                          {lead.rentcast.low && lead.rentcast.high && (
                            <span className="text-slate-500">(${lead.rentcast.low.toLocaleString()} – ${lead.rentcast.high.toLocaleString()})</span>
                          )}
                        </div>
                      )}
                      {lead.rentcast.lastSalePrice && (
                        <div className="flex items-center gap-2">
                          <span className="text-slate-400 w-20 flex-shrink-0">Last Sale:</span>
                          <span className="text-slate-300">${lead.rentcast.lastSalePrice.toLocaleString()}{lead.rentcast.lastSaleDate ? ` (${lead.rentcast.lastSaleDate})` : ''}</span>
                        </div>
                      )}
                      {(lead.rentcast.sqft || lead.rentcast.beds) && (
                        <div className="flex gap-3 text-slate-500">
                          {lead.rentcast.beds && <span>{lead.rentcast.beds} bed</span>}
                          {lead.rentcast.baths && <span>{lead.rentcast.baths} bath</span>}
                          {lead.rentcast.sqft && <span>{lead.rentcast.sqft.toLocaleString()} sqft</span>}
                          {lead.rentcast.yearBuilt && <span>Built {lead.rentcast.yearBuilt}</span>}
                        </div>
                      )}
                    </div>
                  )}

                  <div className="flex gap-2 pt-1 flex-wrap">
                    {!contacted.has(lead.woId) && (
                      <Button
                        variant="success"
                        size="sm"
                        onClick={() => setContacted(prev => new Set([...prev, lead.woId]))}
                      >
                        <CheckCircle2 className="w-3 h-3" />
                        Mark Contacted
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={exportState === 'exporting' || exportState === 'done'}
                      onClick={() => handleExportOne(lead)}
                      title="Push to CRM"
                    >
                      {exportState === 'exporting'
                        ? <Loader2 className="w-3 h-3 animate-spin" />
                        : <Upload className="w-3 h-3" />
                      }
                      {exportState === 'done' ? 'In CRM' : exportState === 'error' ? 'Retry Export' : 'Push to CRM'}
                    </Button>
                  </div>
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {/* SmartMail Tab */}
      {!loading && activeTab === 'smartmail' && (
        <SmartMailTab batches={smartBatches} onRefresh={() => loadAll(true)} />
      )}
    </div>
  )
}
