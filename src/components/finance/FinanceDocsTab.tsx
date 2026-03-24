import { useState, useEffect, useCallback, useRef } from 'react'
import { FileText, RefreshCw, Loader2, Search, CheckCircle2, AlertCircle, XCircle, Eye, Paperclip, Building2, User, UserPlus } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { Badge } from '@/components/ui/Badge'
import { Modal } from '@/components/ui/Modal'
import { cn } from '@/lib/utils'

// ── Types ────────────────────────────────────────────────────────────────────

interface PdfInfo {
  name: string
  attachmentId: string
  size?: number
}

interface SfMatch {
  Id: string
  objectType: 'Account' | 'Contact' | 'Lead'
  Name: string
  FirstName?: string | null
  LastName?: string | null
  AccountId?: string | null
  Street?: string | null
  City?: string | null
  State?: string | null
  Phone?: string | null
  Status?: string | null
}

interface PendingEmail {
  emailId: string
  subject: string
  from: string
  lender: string
  date: string
  customerName: string | null
  amount: number | null
  approvalStatus: 'approved' | 'declined' | 'unknown'
  pdfs: PdfInfo[]
  suggestedMatches: SfMatch[]
}

interface AttachState {
  [key: string]: 'attaching' | 'done' | 'error'
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const LENDER_COLORS: Record<string, string> = {
  ISPC: 'bg-blue-900/50 text-blue-300 border-blue-700/60',
  Foundation: 'bg-violet-900/50 text-violet-300 border-violet-700/60',
  Synchrony: 'bg-cyan-900/50 text-cyan-300 border-cyan-700/60',
  Aqua: 'bg-teal-900/50 text-teal-300 border-teal-700/60',
}

const APPROVAL_CONFIG = {
  approved: { label: 'APPROVED', variant: 'active' as const, icon: CheckCircle2 },
  declined: { label: 'DECLINED', variant: 'failed' as const, icon: XCircle },
  unknown: { label: 'PENDING', variant: 'default' as const, icon: AlertCircle },
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function fmtDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function fmt$(n: number | null) {
  if (n == null) return null
  return '$' + Number(n).toLocaleString()
}

function objectIcon(type: string) {
  if (type === 'Account') return Building2
  if (type === 'Contact') return User
  return UserPlus
}

function objectColor(type: string) {
  if (type === 'Account') return 'text-emerald-400'
  if (type === 'Contact') return 'text-blue-400'
  return 'text-amber-400'
}

const SF_BASE = 'https://rainsoftse.my.salesforce.com'

// ── Main Component ───────────────────────────────────────────────────────────

export function FinanceDocsTab() {
  const [emails, setEmails] = useState<PendingEmail[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [attachStates, setAttachStates] = useState<AttachState>({})
  const [pdfModal, setPdfModal] = useState<{ emailId: string; attachmentId: string; name: string } | null>(null)

  // Per-card: selected SF record + search state
  const [selectedRecords, setSelectedRecords] = useState<Record<string, SfMatch>>({})
  const [searchQueries, setSearchQueries] = useState<Record<string, string>>({})
  const [searchResults, setSearchResults] = useState<Record<string, SfMatch[]>>({})
  const [searching, setSearching] = useState<Record<string, boolean>>({})
  const debounceTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const r = await fetch('/api/finance-emails/pending')
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const data = await r.json()
      setEmails(data)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  // ── Search SF records with debounce ──

  function handleSearch(emailId: string, query: string) {
    setSearchQueries(prev => ({ ...prev, [emailId]: query }))

    if (debounceTimers.current[emailId]) {
      clearTimeout(debounceTimers.current[emailId])
    }

    if (query.trim().length < 2) {
      setSearchResults(prev => ({ ...prev, [emailId]: [] }))
      return
    }

    debounceTimers.current[emailId] = setTimeout(async () => {
      setSearching(prev => ({ ...prev, [emailId]: true }))
      try {
        const r = await fetch(`/api/sf/search-records?q=${encodeURIComponent(query.trim())}`)
        if (!r.ok) throw new Error('Search failed')
        const results = await r.json()
        setSearchResults(prev => ({ ...prev, [emailId]: results }))
      } catch {
        setSearchResults(prev => ({ ...prev, [emailId]: [] }))
      } finally {
        setSearching(prev => ({ ...prev, [emailId]: false }))
      }
    }, 300)
  }

  function selectRecord(emailId: string, record: SfMatch) {
    setSelectedRecords(prev => ({ ...prev, [emailId]: record }))
    setSearchQueries(prev => ({ ...prev, [emailId]: '' }))
    setSearchResults(prev => ({ ...prev, [emailId]: [] }))
  }

  // ── Attach PDF ──

  async function attachPdf(email: PendingEmail, pdf: PdfInfo) {
    const record = selectedRecords[email.emailId] || email.suggestedMatches[0]
    if (!record) return

    const key = `${email.emailId}:${pdf.attachmentId}`
    setAttachStates(prev => ({ ...prev, [key]: 'attaching' }))

    try {
      const r = await fetch('/api/finance-emails/attach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailId: email.emailId,
          attachmentId: pdf.attachmentId,
          pdfName: pdf.name,
          sfRecordId: record.Id,
          sfObjectType: record.objectType,
          lender: email.lender,
        }),
      })
      if (!r.ok) {
        const data = await r.json()
        throw new Error(data.error || 'Failed')
      }
      setAttachStates(prev => ({ ...prev, [key]: 'done' }))
    } catch {
      setAttachStates(prev => ({ ...prev, [key]: 'error' }))
    }
  }

  // Check if all PDFs for an email are attached
  function allAttached(email: PendingEmail) {
    return email.pdfs.every(p => attachStates[`${email.emailId}:${p.attachmentId}`] === 'done')
  }

  // ── Render ──

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FileText className="w-5 h-5 text-violet-400" />
          <h2 className="text-lg font-semibold text-white">Finance Docs</h2>
          {!loading && (
            <span className="text-xs text-slate-500">{emails.length} pending</span>
          )}
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

      {loading && emails.length === 0 ? (
        <Card>
          <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Scanning finance emails…</span>
          </div>
        </Card>
      ) : emails.length === 0 ? (
        <Card>
          <div className="py-16 text-center">
            <FileText className="w-10 h-10 text-slate-700 mx-auto mb-3" />
            <p className="text-white font-medium">No pending finance docs</p>
            <p className="text-sm text-slate-500 mt-1">All PDFs have been matched and attached to Salesforce.</p>
          </div>
        </Card>
      ) : (
        <div className="space-y-4">
          {emails.map(email => {
            const approvalCfg = APPROVAL_CONFIG[email.approvalStatus]
            const ApprovalIcon = approvalCfg.icon
            const record = selectedRecords[email.emailId]
            const suggestion = email.suggestedMatches[0]
            const activeRecord = record || suggestion
            const cardDone = allAttached(email)

            return (
              <Card
                key={email.emailId}
                className={cn(cardDone && 'opacity-60 border-emerald-800/30')}
              >
                <div className="p-5 space-y-4">
                  {/* Card header: Lender, date, status */}
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <span className={cn(
                        'inline-flex items-center px-2.5 py-1 rounded-md text-xs font-semibold border',
                        LENDER_COLORS[email.lender] || 'bg-slate-800 text-slate-300 border-slate-700'
                      )}>
                        {email.lender}
                      </span>
                      <Badge variant={approvalCfg.variant}>
                        <ApprovalIcon className="w-3 h-3 mr-1" />
                        {approvalCfg.label}
                      </Badge>
                      {email.amount && (
                        <span className="text-sm font-medium text-emerald-400">{fmt$(email.amount)}</span>
                      )}
                    </div>
                    <span className="text-xs text-slate-500 whitespace-nowrap flex-shrink-0">
                      {fmtDate(email.date)} · {timeAgo(email.date)}
                    </span>
                  </div>

                  {/* Subject + customer */}
                  <div>
                    <p className="text-sm text-white font-medium">{email.subject}</p>
                    {email.customerName && (
                      <p className="text-xs text-slate-400 mt-1">
                        Detected customer: <span className="text-slate-200 font-medium">{email.customerName}</span>
                      </p>
                    )}
                    <p className="text-xs text-slate-600 mt-0.5">From: {email.from}</p>
                  </div>

                  {/* PDFs */}
                  <div className="space-y-2">
                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">PDF Attachments</p>
                    {email.pdfs.map(pdf => {
                      const key = `${email.emailId}:${pdf.attachmentId}`
                      const state = attachStates[key]
                      return (
                        <div key={pdf.attachmentId} className="flex items-center gap-3 bg-slate-800/50 border border-slate-700/50 rounded-lg px-3 py-2">
                          <FileText className="w-4 h-4 text-red-400 flex-shrink-0" />
                          <span className="text-sm text-slate-200 flex-1 truncate">{pdf.name}</span>
                          {pdf.size && (
                            <span className="text-xs text-slate-600">{(pdf.size / 1024).toFixed(0)}KB</span>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setPdfModal({ emailId: email.emailId, attachmentId: pdf.attachmentId, name: pdf.name })}
                          >
                            <Eye className="w-3 h-3" />
                            View
                          </Button>
                          {state === 'done' ? (
                            <span className="inline-flex items-center gap-1 text-xs text-emerald-400 font-medium">
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              Attached
                            </span>
                          ) : state === 'attaching' ? (
                            <span className="inline-flex items-center gap-1 text-xs text-blue-400">
                              <Loader2 className="w-3 h-3 animate-spin" />
                              Attaching…
                            </span>
                          ) : state === 'error' ? (
                            <Button variant="danger" size="sm" onClick={() => attachPdf(email, pdf)}>
                              Retry
                            </Button>
                          ) : activeRecord ? (
                            <Button variant="primary" size="sm" onClick={() => attachPdf(email, pdf)}>
                              <Paperclip className="w-3 h-3" />
                              Attach
                            </Button>
                          ) : (
                            <span className="text-xs text-slate-600 italic">Select customer first</span>
                          )}
                        </div>
                      )
                    })}
                  </div>

                  {/* Done banner */}
                  {cardDone ? (
                    <div className="flex items-center gap-2 bg-emerald-950/40 border border-emerald-800/50 rounded-lg p-3">
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      <span className="text-sm text-emerald-300 font-medium">
                        ✅ Attached to Salesforce
                      </span>
                      {activeRecord && (
                        <a
                          href={`${SF_BASE}/${activeRecord.Id}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-xs text-emerald-400 underline ml-auto"
                        >
                          View {activeRecord.objectType} →
                        </a>
                      )}
                    </div>
                  ) : (
                    <>
                      {/* Customer matching section */}
                      <div className="space-y-3 border-t border-slate-800 pt-4">
                        <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide">Match to Salesforce Record</p>

                        {/* Suggested match */}
                        {suggestion && !record && (
                          <div className="flex items-center gap-3 bg-slate-800/60 border border-slate-700 rounded-lg p-3">
                            <SfRecordLine record={suggestion} />
                            <Button variant="success" size="sm" onClick={() => selectRecord(email.emailId, suggestion)}>
                              <CheckCircle2 className="w-3 h-3" />
                              That's correct
                            </Button>
                          </div>
                        )}

                        {/* Currently selected (if different from suggestion) */}
                        {record && (
                          <div className="flex items-center gap-3 bg-emerald-950/30 border border-emerald-800/50 rounded-lg p-3">
                            <CheckCircle2 className="w-4 h-4 text-emerald-400 flex-shrink-0" />
                            <SfRecordLine record={record} />
                            <button
                              onClick={() => setSelectedRecords(prev => { const n = { ...prev }; delete n[email.emailId]; return n })}
                              className="text-xs text-slate-500 hover:text-slate-300 ml-auto flex-shrink-0"
                            >
                              Change
                            </button>
                          </div>
                        )}

                        {/* Search different customer */}
                        <div className="relative">
                          <div className="flex items-center gap-2 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2">
                            <Search className="w-3.5 h-3.5 text-slate-500 flex-shrink-0" />
                            <input
                              type="text"
                              placeholder="Search different customer…"
                              value={searchQueries[email.emailId] || ''}
                              onChange={e => handleSearch(email.emailId, e.target.value)}
                              className="flex-1 bg-transparent text-sm text-white placeholder-slate-500 outline-none"
                            />
                            {searching[email.emailId] && <Loader2 className="w-3.5 h-3.5 text-slate-500 animate-spin" />}
                          </div>

                          {/* Search dropdown */}
                          {(searchResults[email.emailId]?.length ?? 0) > 0 && (
                            <div className="absolute z-20 top-full left-0 right-0 mt-1 bg-slate-800 border border-slate-600 rounded-lg shadow-xl max-h-60 overflow-y-auto">
                              {searchResults[email.emailId]!.map(r => (
                                <button
                                  key={`${r.objectType}-${r.Id}`}
                                  onClick={() => selectRecord(email.emailId, r)}
                                  className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-slate-700/60 transition-colors text-left border-b border-slate-700/50 last:border-0"
                                >
                                  <SfRecordLine record={r} />
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </Card>
            )
          })}
        </div>
      )}

      {/* PDF Viewer Modal */}
      <Modal
        open={!!pdfModal}
        onClose={() => setPdfModal(null)}
        title={pdfModal?.name || 'PDF Viewer'}
        size="lg"
      >
        {pdfModal && (
          <div className="p-1">
            <iframe
              src={`/api/finance-emails/pdf/${encodeURIComponent(pdfModal.emailId)}/${encodeURIComponent(pdfModal.attachmentId)}`}
              className="w-full rounded-lg bg-white"
              style={{ height: '75vh' }}
              title={pdfModal.name}
            />
          </div>
        )}
      </Modal>
    </div>
  )
}

// ── SF Record display line ───────────────────────────────────────────────────

function SfRecordLine({ record }: { record: SfMatch }) {
  const Icon = objectIcon(record.objectType)
  const color = objectColor(record.objectType)
  const address = [record.Street, record.City, record.State].filter(Boolean).join(', ')

  return (
    <div className="flex items-center gap-2.5 flex-1 min-w-0">
      <Icon className={cn('w-4 h-4 flex-shrink-0', color)} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm text-white font-medium truncate">{record.Name}</span>
          <span className={cn('text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded', color, 'bg-slate-700/50')}>
            {record.objectType}
          </span>
          {record.Status && (
            <span className="text-[10px] text-slate-500">{record.Status}</span>
          )}
        </div>
        {(address || record.Phone) && (
          <p className="text-xs text-slate-500 truncate">
            {address}{address && record.Phone ? ' — ' : ''}{record.Phone}
          </p>
        )}
      </div>
    </div>
  )
}
