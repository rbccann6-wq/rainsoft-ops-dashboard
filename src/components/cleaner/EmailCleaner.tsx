import { useState, useCallback } from 'react'
import { Trash2, RefreshCw, Loader2, AlertCircle, ShieldCheck, ShieldAlert, Inbox, Search, CheckCircle2 } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

interface Sender {
  name: string
  email: string
  domain: string
  count: number
  safe: boolean
  samples: { subject: string; date: string }[]
}

interface ScanResult {
  senders: Sender[]
  totalScanned: number
  totalSenders: number
  pagesScanned: number
}

interface JunkResult {
  rescued: { id: string; sender: string; senderEmail: string; subject: string; date: string }[]
  junk: { id: string; sender: string; senderEmail: string; subject: string; date: string }[]
  total: number
}

type DeleteState = 'idle' | 'deleting' | 'done' | 'error'

const MAX_RETRIES = 3
async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: Error = new Error('Unknown')
  for (let i = 1; i <= MAX_RETRIES; i++) {
    try { return await fn() } catch (e) {
      lastErr = e as Error
      if (i < MAX_RETRIES) await new Promise(r => setTimeout(r, 1000 * i))
    }
  }
  throw new Error(`${label} failed: ${lastErr.message}`)
}

async function apiFetch<T>(path: string, opts?: RequestInit): Promise<T> {
  const r = await fetch(`/api${path}`, opts)
  if (!r.ok) {
    const data = await r.json().catch(() => ({}))
    throw new Error(data.error ?? `HTTP ${r.status}`)
  }
  return r.json()
}

export function EmailCleaner() {
  const [tab, setTab] = useState<'senders' | 'junk'>('senders')
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [deleteStates, setDeleteStates] = useState<Record<string, DeleteState>>({})
  const [deleteCounts, setDeleteCounts] = useState<Record<string, number>>({})
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'spam' | 'safe'>('all')
  const [junkResult, setJunkResult] = useState<JunkResult | null>(null)
  const [junkLoading, setJunkLoading] = useState(false)
  const [junkError, setJunkError] = useState<string | null>(null)
  const [movingIds, setMovingIds] = useState<Set<string>>(new Set())
  const [movedIds, setMovedIds] = useState<Set<string>>(new Set())

  const runScan = useCallback(async () => {
    setScanning(true)
    setScanError(null)
    setScanResult(null)
    try {
      const data = await withRetry(
        () => apiFetch<ScanResult>('/cleaner/senders'),
        'scan'
      )
      setScanResult(data)
    } catch (err) {
      setScanError((err as Error).message)
    } finally {
      setScanning(false)
    }
  }, [])

  const deleteSender = useCallback(async (email: string) => {
    setDeleteStates(s => ({ ...s, [email]: 'deleting' }))
    try {
      const result = await withRetry(
        () => apiFetch<{ deleted: number; failed: number }>('/cleaner/delete-sender', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ senderEmail: email }),
        }),
        'delete'
      )
      setDeleteStates(s => ({ ...s, [email]: result.failed > 0 ? 'error' : 'done' }))
      setDeleteCounts(s => ({ ...s, [email]: result.deleted }))
    } catch (err) {
      setDeleteStates(s => ({ ...s, [email]: 'error' }))
    }
  }, [])

  const loadJunk = useCallback(async () => {
    setJunkLoading(true)
    setJunkError(null)
    try {
      const data = await withRetry(
        () => apiFetch<JunkResult>('/cleaner/junk'),
        'junk'
      )
      setJunkResult(data)
    } catch (err) {
      setJunkError((err as Error).message)
    } finally {
      setJunkLoading(false)
    }
  }, [])

  const moveToInbox = useCallback(async (id: string, senderEmail?: string) => {
    setMovingIds(prev => new Set([...prev, id]))
    try {
      // Use safelist/add — moves to inbox AND adds to permanent safelist + M365 override
      await withRetry(
        () => apiFetch('/safelist/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ senderEmail, messageId: id }),
        }),
        'move'
      )
      setMovedIds(prev => new Set([...prev, id]))
    } catch {
      // best effort
    } finally {
      setMovingIds(prev => { const n = new Set(prev); n.delete(id); return n })
    }
  }, [])

  // Filter senders
  const filteredSenders = (scanResult?.senders ?? []).filter(s => {
    if (filter === 'spam' && s.safe) return false
    if (filter === 'safe' && !s.safe) return false
    if (search) {
      const q = search.toLowerCase()
      return s.email.includes(q) || s.name.toLowerCase().includes(q) || s.domain.includes(q)
    }
    return true
  })

  const totalSpamCount = scanResult?.senders
    .filter(s => !s.safe)
    .reduce((sum, s) => sum + s.count, 0) ?? 0

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <Trash2 className="w-5 h-5 text-red-400" />
            <h2 className="text-lg font-semibold text-white">Email Cleaner</h2>
          </div>
          <p className="text-xs text-slate-500 mt-0.5 ml-8">Bulk-delete by sender · Rescue emails from Junk</p>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-slate-800">
        {[
          { key: 'senders', label: 'Bulk Delete by Sender' },
          { key: 'junk', label: 'Rescue from Junk' },
        ].map(t => (
          <button key={t.key} onClick={() => setTab(t.key as typeof tab)}
            className={cn(
              'px-4 py-2 text-sm font-medium border-b-2 transition-colors',
              tab === t.key ? 'border-red-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-300'
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── SENDERS TAB ── */}
      {tab === 'senders' && (
        <div className="space-y-4">
          {!scanResult && !scanning && (
            <Card>
              <div className="p-8 text-center space-y-4">
                <Trash2 className="w-10 h-10 text-slate-600 mx-auto" />
                <div>
                  <p className="text-white font-medium">Scan all 60,000+ emails</p>
                  <p className="text-sm text-slate-400 mt-1">
                    Groups every email by sender. You pick who to wipe — one click deletes all from that sender.
                    Safe business senders are protected and can't be deleted.
                  </p>
                </div>
                <Button variant="primary" onClick={runScan}>
                  Start Full Scan
                </Button>
              </div>
            </Card>
          )}

          {scanning && (
            <Card>
              <div className="p-8 text-center space-y-3">
                <Loader2 className="w-8 h-8 text-blue-400 mx-auto animate-spin" />
                <p className="text-white font-medium">Scanning your inbox…</p>
                <p className="text-sm text-slate-400">
                  Pulling all emails in batches. This may take 1–3 minutes for 60k emails.
                </p>
              </div>
            </Card>
          )}

          {scanError && (
            <div className="flex items-start gap-3 bg-red-950/40 border border-red-700 rounded-xl p-4">
              <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-red-300">Scan failed</p>
                <p className="text-xs text-slate-400 mt-0.5">{scanError}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={runScan} className="ml-auto">Retry</Button>
            </div>
          )}

          {scanResult && (
            <>
              {/* Stats */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Card><div className="p-4 text-center">
                  <p className="text-xs text-slate-500 mb-1">Emails Scanned</p>
                  <p className="text-2xl font-bold text-white">{scanResult.totalScanned.toLocaleString()}</p>
                </div></Card>
                <Card><div className="p-4 text-center">
                  <p className="text-xs text-slate-500 mb-1">Unique Senders</p>
                  <p className="text-2xl font-bold text-white">{scanResult.totalSenders.toLocaleString()}</p>
                </div></Card>
                <Card><div className="p-4 text-center">
                  <p className="text-xs text-slate-500 mb-1">Deletable Emails</p>
                  <p className="text-2xl font-bold text-red-400">{totalSpamCount.toLocaleString()}</p>
                </div></Card>
                <Card><div className="p-4 text-center">
                  <p className="text-xs text-slate-500 mb-1">Protected</p>
                  <p className="text-2xl font-bold text-green-400">{scanResult.senders.filter(s => s.safe).length}</p>
                  <p className="text-xs text-slate-500">safe senders</p>
                </div></Card>
              </div>

              {/* Filters */}
              <div className="flex flex-wrap gap-2 items-center">
                <div className="flex items-center gap-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 flex-1 min-w-[200px]">
                  <Search className="w-3.5 h-3.5 text-slate-500" />
                  <input
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search sender…"
                    className="bg-transparent text-sm text-white placeholder-slate-500 outline-none flex-1"
                  />
                </div>
                {(['all', 'spam', 'safe'] as const).map(f => (
                  <button key={f} onClick={() => setFilter(f)}
                    className={cn(
                      'px-3 py-1.5 text-xs rounded-lg border transition-colors capitalize',
                      filter === f
                        ? 'bg-blue-600/20 border-blue-700/50 text-blue-300'
                        : 'border-slate-700 text-slate-400 hover:text-slate-200'
                    )}
                  >
                    {f === 'spam' ? '🚫 Deletable' : f === 'safe' ? '✅ Protected' : 'All'}
                  </button>
                ))}
                <Button variant="ghost" size="sm" onClick={runScan} disabled={scanning}>
                  <RefreshCw className="w-3 h-3" /> Rescan
                </Button>
              </div>

              {/* Sender list */}
              <div className="space-y-2">
                {filteredSenders.map(sender => {
                  const state = deleteStates[sender.email] ?? 'idle'
                  const deleted = deleteCounts[sender.email]
                  return (
                    <Card key={sender.email} className={cn(state === 'done' && 'opacity-40')}>
                      <div className="p-3 flex items-start gap-3">
                        <div className="mt-0.5 flex-shrink-0">
                          {sender.safe
                            ? <ShieldCheck className="w-4 h-4 text-green-400" />
                            : <ShieldAlert className="w-4 h-4 text-red-400/70" />
                          }
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <p className="text-sm font-medium text-white truncate">{sender.name}</p>
                            <span className="text-xs text-slate-500 truncate">{sender.email}</span>
                          </div>
                          <div className="flex flex-wrap gap-3 mt-1 text-xs text-slate-500">
                            <span className={cn('font-semibold', sender.safe ? 'text-green-400' : 'text-red-400')}>
                              {sender.count.toLocaleString()} emails
                            </span>
                            {sender.samples[0] && (
                              <span className="truncate max-w-[300px]">e.g. "{sender.samples[0].subject}"</span>
                            )}
                          </div>
                        </div>
                        <div className="flex-shrink-0 flex flex-col items-end gap-1">
                          {sender.safe ? (
                            <span className="text-xs text-green-400/70 flex items-center gap-1">
                              <ShieldCheck className="w-3 h-3" /> Protected
                            </span>
                          ) : state === 'done' ? (
                            <span className="text-xs text-green-400 flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3" /> {deleted?.toLocaleString()} deleted
                            </span>
                          ) : state === 'error' ? (
                            <Button variant="ghost" size="sm" onClick={() => deleteSender(sender.email)}>
                              Retry
                            </Button>
                          ) : (
                            <Button
                              variant="ghost"
                              size="sm"
                              disabled={state === 'deleting'}
                              onClick={() => deleteSender(sender.email)}
                              className="text-red-400 hover:text-red-300 border-red-900/50 hover:border-red-700"
                            >
                              {state === 'deleting'
                                ? <><Loader2 className="w-3 h-3 animate-spin" /> Deleting…</>
                                : <><Trash2 className="w-3 h-3" /> Delete all {sender.count.toLocaleString()}</>
                              }
                            </Button>
                          )}
                        </div>
                      </div>
                    </Card>
                  )
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* ── JUNK TAB ── */}
      {tab === 'junk' && (
        <div className="space-y-4">
          {!junkResult && !junkLoading && (
            <Card>
              <div className="p-8 text-center space-y-4">
                <Inbox className="w-10 h-10 text-slate-600 mx-auto" />
                <div>
                  <p className="text-white font-medium">Check your Junk folder</p>
                  <p className="text-sm text-slate-400 mt-1">
                    Scans the last 200 emails in Junk and flags any from business/important senders
                    that got caught by accident.
                  </p>
                </div>
                <Button variant="primary" onClick={loadJunk}>Scan Junk Folder</Button>
              </div>
            </Card>
          )}

          {junkLoading && (
            <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">Scanning Junk folder…</span>
            </div>
          )}

          {junkError && (
            <div className="flex items-start gap-3 bg-red-950/40 border border-red-700 rounded-xl p-4">
              <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-red-300">Failed to load Junk</p>
                <p className="text-xs text-slate-400">{junkError}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={loadJunk} className="ml-auto">Retry</Button>
            </div>
          )}

          {junkResult && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <p className="text-sm text-slate-400">{junkResult.total} emails in Junk scanned</p>
                <Button variant="ghost" size="sm" onClick={loadJunk} disabled={junkLoading}>
                  <RefreshCw className="w-3 h-3" /> Refresh
                </Button>
              </div>

              {/* Rescued */}
              {junkResult.rescued.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-green-400" />
                    <p className="text-sm font-semibold text-green-300">
                      {junkResult.rescued.length} important emails in Junk — move them back
                    </p>
                  </div>
                  {junkResult.rescued.filter(e => !movedIds.has(e.id)).map(email => (
                    <Card key={email.id} className="border-green-800/40">
                      <div className="p-3 flex items-start gap-3">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-white truncate">{email.sender}</p>
                          <p className="text-xs text-slate-400 truncate">{email.subject}</p>
                          <p className="text-xs text-slate-600 mt-0.5">{email.senderEmail}</p>
                        </div>
                        <Button
                          variant="success"
                          size="sm"
                          disabled={movingIds.has(email.id)}
                          onClick={() => moveToInbox(email.id, email.senderEmail)}
                        >
                          {movingIds.has(email.id)
                            ? <Loader2 className="w-3 h-3 animate-spin" />
                            : <><Inbox className="w-3 h-3" /> Move to Inbox</>
                          }
                        </Button>
                      </div>
                    </Card>
                  ))}
                  {junkResult.rescued.every(e => movedIds.has(e.id)) && (
                    <p className="text-sm text-green-400 text-center py-2">✅ All rescued emails moved to inbox</p>
                  )}
                </div>
              )}

              {junkResult.rescued.length === 0 && (
                <div className="bg-green-950/20 border border-green-800/40 rounded-xl p-4 text-sm text-green-300 flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4" />
                  No important emails found in Junk — looks clean.
                </div>
              )}

              {/* Actual junk */}
              {junkResult.junk.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-slate-500">{junkResult.junk.length} emails confirmed junk (no action needed)</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
