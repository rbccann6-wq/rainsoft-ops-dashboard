import { useState, useEffect, useCallback } from 'react'
import { Target, RefreshCw, Loader2, Phone, MapPin, Store, AlertCircle, CheckCircle2, Upload, Download } from 'lucide-react'
import type { ImeLead, SmartMailBatch } from '@/types'
import { fetchImeLeads, fetchSmartMailBatches, exportLeadToCrm, exportAllToCrm } from '@/lib/leadsApi'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

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

  const loadAll = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [imeData, smartData] = await Promise.all([
        fetchImeLeads(),
        fetchSmartMailBatches(),
      ])
      setImeLeads(imeData.leads)
      setSmartBatches(smartData)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  const pendingCount = imeLeads.filter(l => !contacted.has(l.woId)).length

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
          <Button variant="ghost" size="sm" onClick={loadAll} disabled={loading}>
            {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <div className="flex items-start gap-3 bg-red-950/40 border border-red-700 rounded-xl p-4">
          <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-red-300">Failed to load leads</p>
            <p className="text-xs text-slate-400 mt-0.5">{error}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={loadAll} className="ml-auto">Retry</Button>
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
                {imeLeads.length}
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
          {imeLeads.length === 0 && !error && (
            <p className="text-sm text-slate-500 py-8 text-center">No pending Lowe's leads.</p>
          )}
          {imeLeads.map(lead => {
            const exportState = exportStates[lead.woId] ?? 'idle'
            return (
              <Card key={lead.woId} className={cn(contacted.has(lead.woId) && 'opacity-60')}>
                <div className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-white">{lead.customerName}</p>
                      <p className="text-xs text-slate-500">WO #{lead.woId} · {timeAgo(lead.emailDate)}</p>
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

      {/* SmartMail Batches */}
      {!loading && activeTab === 'smartmail' && (
        <div className="space-y-3">
          {smartBatches.length === 0 && !error && (
            <p className="text-sm text-slate-500 py-8 text-center">No SmartMail batches found.</p>
          )}
          {smartBatches.map(batch => (
            <Card key={batch.emailId}>
              <div className="p-4 flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-white">{batch.subject}</p>
                  <p className="text-xs text-slate-500">{timeAgo(batch.date)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="draft">PDF Ready</Badge>
                  <Button variant="ghost" size="sm" disabled title="OCR coming soon">
                    <Upload className="w-3 h-3" />
                    Extract & Push
                  </Button>
                </div>
              </div>
            </Card>
          ))}
          <div className="bg-amber-950/30 border border-amber-700/50 rounded-xl p-4 text-sm text-amber-300">
            🔬 OCR extraction coming soon — Google Vision will auto-parse these card scans into structured leads and push them to CRM.
          </div>
        </div>
      )}
    </div>
  )
}
