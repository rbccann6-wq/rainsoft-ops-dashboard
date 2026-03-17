import { useState, useCallback, useEffect, useRef } from 'react'
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

interface ScanStatus {
  status: 'idle' | 'running' | 'done' | 'error'
  pagesScanned: number
  totalScanned: number
  totalSenders: number
  startedAt: string | null
  finishedAt: string | null
  error: string | null
  senders: Sender[]
}

interface JunkEmail {
  id: string
  sender: string
  senderEmail: string
  subject: string
  date: string
}

interface JunkResult {
  rescued: JunkEmail[]
  junk: JunkEmail[]
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
    throw new Error((data as any).error ?? `HTTP ${r.status}`)
  }
  return r.json()
}

export function EmailCleaner() {
  const [tab, setTab] = useState<'senders' | 'junk'>('senders')

  // Scan state
  const [scanStatus, setScanStatus] = useState<ScanStatus | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Delete state
  const [deleteStates, setDeleteStates] = useState<Record<string, DeleteState>>({})
  const [deleteCounts, setDeleteCounts] = useState<Record<string, number>>({})
  // Locally protected senders (user clicked "Keep" — persisted to safelist)
  const [keptEmails, setKeptEmails] = useState<Set<string>>(new Set())

  // Filter/search
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | 'spam' | 'safe'>('all')

  // Junk state
  const [junkResult, setJunkResult] = useState<JunkResult | null>(null)
  const [junkLoading, setJunkLoading] = useState(false)
  const [junkError, setJunkError] = useState<string | null>(null)
  const [movingIds, setMovingIds] = useState<Set<string>>(new Set())
  const [movedIds, setMovedIds] = useState<Set<string>>(new Set())

  // Poll scan status while running
  const pollStatus = useCallback(async () => {
    try {
      const data = await apiFetch<ScanStatus>('/cleaner/scan/status')
      setScanStatus(data)
      if (data.status === 'done' || data.status === 'error') {
        if (pollRef.current) clearInterval(pollRef.current)
      }
    } catch (err) {
      setScanError((err as Error).message)
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  // On mount — check if a scan is already in progress or done
  useEffect(() => {
    pollStatus()
  }, [pollStatus])

  const startScan = useCallback(async (force = false) => {
    setScanError(null)
    try {
      await apiFetch('/cleaner/scan/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force }),
      })
      await pollStatus()
      // Only poll if actually running
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(async () => {
        const data = await apiFetch<ScanStatus>('/cleaner/scan/status')
        setScanStatus(data)
        if (data.status === 'done' || data.status === 'error') {
          clearInterval(pollRef.current!)
        }
      }, 3000)
    } catch (err) {
      setScanError((err as Error).message)
    }
  }, [pollStatus])

  useEffect(() => {
    // If already running when we load, start polling
    if (scanStatus?.status === 'running') {
      if (pollRef.current) clearInterval(pollRef.current)
      pollRef.current = setInterval(pollStatus, 3000)
    }
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [scanStatus?.status, pollStatus])

  const keepSender = useCallback(async (email: string) => {
    // Optimistic UI
    setKeptEmails(prev => new Set([...prev, email]))
    // Add to permanent safelist so it never gets flagged again
    try {
      await apiFetch('/safelist/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ senderEmail: email }),
      })
    } catch { /* best effort — UI already updated */ }
  }, [])

  const deleteSender = useCallback(async (email: string) => {
    setDeleteStates(s => ({ ...s, [email]: 'deleting' }))
    try {
      // Delete can take a while on large senders — single attempt with long timeout
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 120000) // 2 min timeout
      let result: { deleted: number; failed: number }
      try {
        const r = await fetch('/api/cleaner/delete-sender', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ senderEmail: email }),
          signal: controller.signal,
        })
        clearTimeout(timeout)
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        result = await r.json()
      } finally {
        clearTimeout(timeout)
      }
      setDeleteStates(s => ({ ...s, [email]: result.failed > 0 ? 'error' : 'done' }))
      setDeleteCounts(s => ({ ...s, [email]: result.deleted }))
    } catch (err) {
      console.error('Delete failed:', err)
      setDeleteStates(s => ({ ...s, [email]: 'error' }))
    }
  }, [])

  const loadJunk = useCallback(async () => {
    setJunkLoading(true)
    setJunkError(null)
    try {
      const data = await withRetry(() => apiFetch<JunkResult>('/cleaner/junk'), 'junk')
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
      await withRetry(
        () => apiFetch('/safelist/add', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ senderEmail, messageId: id }),
        }),
        'move'
      )
      setMovedIds(prev => new Set([...prev, id]))
    } catch { /* best effort */ } finally {
      setMovingIds(prev => { const n = new Set(prev); n.delete(id); return n })
    }
  }, [])

  const senders = scanStatus?.senders ?? []
  const filteredSenders = senders.filter(s => {
    if (filter === 'spam' && s.safe) return false
    if (filter === 'safe' && !s.safe) return false
    if (search) {
      const q = search.toLowerCase()
      return s.email.includes(q) || s.name.toLowerCase().includes(q) || s.domain.includes(q)
    }
    return true
  })

  const totalSpamCount = senders.filter(s => !s.safe).reduce((sum, s) => sum + s.count, 0)
  const isRunning = scanStatus?.status === 'running'
  const isDone = scanStatus?.status === 'done'

  return (
    <div className="space-y-5">
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
        {[{ key: 'senders', label: 'Bulk Delete by Sender' }, { key: 'junk', label: 'Rescue from Junk' }].map(t => (
          <button key={t.key} onClick={() => setTab(t.key as typeof tab)}
            className={cn('px-4 py-2 text-sm font-medium border-b-2 transition-colors',
              tab === t.key ? 'border-red-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-300'
            )}>{t.label}</button>
        ))}
      </div>

      {/* ── SENDERS TAB ── */}
      {tab === 'senders' && (
        <div className="space-y-4">

          {/* Not started yet */}
          {scanStatus?.status === 'idle' && !scanError && (
            <Card>
              <div className="p-8 text-center space-y-4">
                <Trash2 className="w-10 h-10 text-slate-600 mx-auto" />
                <div>
                  <p className="text-white font-medium">Scan all 60,000+ emails</p>
                  <p className="text-sm text-slate-400 mt-1">
                    Runs once in the background — results are cached so you never pay to scan again. You pick who to delete.
                    Safe business senders are protected.
                  </p>
                </div>
                <Button variant="primary" onClick={() => startScan()}>Start Full Scan</Button>
              </div>
            </Card>
          )}

          {/* Running — show live progress */}
          {isRunning && (
            <Card>
              <div className="p-6 space-y-4">
                <div className="flex items-center gap-3">
                  <Loader2 className="w-5 h-5 text-blue-400 animate-spin flex-shrink-0" />
                  <div>
                    <p className="text-white font-medium">Scanning your inbox…</p>
                    <p className="text-xs text-slate-400 mt-0.5">Running in background — safe to navigate away</p>
                  </div>
                </div>
                <div className="bg-slate-800 rounded-lg p-3 grid grid-cols-3 gap-4 text-center">
                  <div>
                    <p className="text-xl font-bold text-white">{scanStatus.totalScanned.toLocaleString()}</p>
                    <p className="text-xs text-slate-500">emails scanned</p>
                  </div>
                  <div>
                    <p className="text-xl font-bold text-white">{scanStatus.totalSenders.toLocaleString()}</p>
                    <p className="text-xs text-slate-500">senders found</p>
                  </div>
                  <div>
                    <p className="text-xl font-bold text-white">{scanStatus.pagesScanned}</p>
                    <p className="text-xs text-slate-500">pages done</p>
                  </div>
                </div>
              </div>
            </Card>
          )}

          {/* Error */}
          {(scanError || scanStatus?.status === 'error') && (
            <div className="flex items-start gap-3 bg-red-950/40 border border-red-700 rounded-xl p-4">
              <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-semibold text-red-300">Scan failed</p>
                <p className="text-xs text-slate-400 mt-0.5">{scanError ?? scanStatus?.error}</p>
              </div>
              <Button variant="ghost" size="sm" onClick={() => startScan()} className="ml-auto">Retry</Button>
            </div>
          )}

          {/* Results */}
          {(isDone || (isRunning && senders.length > 0)) && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Card><div className="p-4 text-center">
                  <p className="text-xs text-slate-500 mb-1">Emails Scanned</p>
                  <p className="text-2xl font-bold text-white">{scanStatus!.totalScanned.toLocaleString()}</p>
                  {isRunning && <p className="text-xs text-blue-400 mt-0.5">still scanning…</p>}
                  {isDone && scanStatus?.finishedAt && <p className="text-xs text-slate-500 mt-0.5">cached · {new Date(scanStatus.finishedAt).toLocaleDateString()}</p>}
                </div></Card>
                <Card><div className="p-4 text-center">
                  <p className="text-xs text-slate-500 mb-1">Unique Senders</p>
                  <p className="text-2xl font-bold text-white">{senders.length.toLocaleString()}</p>
                </div></Card>
                <Card><div className="p-4 text-center">
                  <p className="text-xs text-slate-500 mb-1">Deletable Emails</p>
                  <p className="text-2xl font-bold text-red-400">{totalSpamCount.toLocaleString()}</p>
                </div></Card>
                <Card><div className="p-4 text-center">
                  <p className="text-xs text-slate-500 mb-1">Protected</p>
                  <p className="text-2xl font-bold text-green-400">{senders.filter(s => s.safe).length}</p>
                  <p className="text-xs text-slate-500">safe senders</p>
                </div></Card>
              </div>

              <div className="flex flex-wrap gap-2 items-center">
                <div className="flex items-center gap-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 flex-1 min-w-[200px]">
                  <Search className="w-3.5 h-3.5 text-slate-500" />
                  <input value={search} onChange={e => setSearch(e.target.value)}
                    placeholder="Search sender…"
                    className="bg-transparent text-sm text-white placeholder-slate-500 outline-none flex-1" />
                </div>
                {(['all', 'spam', 'safe'] as const).map(f => (
                  <button key={f} onClick={() => setFilter(f)}
                    className={cn('px-3 py-1.5 text-xs rounded-lg border transition-colors capitalize',
                      filter === f ? 'bg-blue-600/20 border-blue-700/50 text-blue-300' : 'border-slate-700 text-slate-400 hover:text-slate-200'
                    )}>
                    {f === 'spam' ? '🚫 Deletable' : f === 'safe' ? '✅ Protected' : 'All'}
                  </button>
                ))}
                {isDone && (
                  <Button variant="ghost" size="sm" onClick={() => startScan(true)}>
                    <RefreshCw className="w-3 h-3" /> Rescan
                  </Button>
                )}
              </div>

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
                            : <ShieldAlert className="w-4 h-4 text-red-400/70" />}
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
                        <div className="flex-shrink-0 flex flex-col items-end gap-1.5">
                          {sender.safe || keptEmails.has(sender.email) ? (
                            <span className="text-xs text-green-400/70 flex items-center gap-1">
                              <ShieldCheck className="w-3 h-3" />
                              {keptEmails.has(sender.email) ? 'Kept — never delete' : 'Protected'}
                            </span>
                          ) : state === 'done' ? (
                            <span className="text-xs text-green-400 flex items-center gap-1">
                              <CheckCircle2 className="w-3 h-3" /> {deleted?.toLocaleString()} deleted
                            </span>
                          ) : (
                            <div className="flex gap-1.5">
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => keepSender(sender.email)}
                                className="text-green-400 hover:text-green-300 border-green-900/50 hover:border-green-700"
                                title="Mark as keep — never delete"
                              >
                                <ShieldCheck className="w-3 h-3" /> Keep
                              </Button>
                              <Button variant="ghost" size="sm"
                                disabled={state === 'deleting'}
                                onClick={() => deleteSender(sender.email)}
                                className="text-red-400 hover:text-red-300 border-red-900/50 hover:border-red-700"
                              >
                                {state === 'deleting'
                                  ? <><Loader2 className="w-3 h-3 animate-spin" /> Deleting…</>
                                  : state === 'error'
                                  ? 'Retry'
                                  : <><Trash2 className="w-3 h-3" /> Delete all {sender.count.toLocaleString()}</>
                                }
                              </Button>
                            </div>
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
                    Finds important emails caught in Junk by mistake. One click rescues them and permanently marks the sender as safe.
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
                <p className="text-sm font-semibold text-red-300">Failed</p>
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

              {junkResult.rescued.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <ShieldCheck className="w-4 h-4 text-green-400" />
                    <p className="text-sm font-semibold text-green-300">
                      {junkResult.rescued.length} important emails caught in Junk
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
                        <Button variant="success" size="sm"
                          disabled={movingIds.has(email.id)}
                          onClick={() => moveToInbox(email.id, email.senderEmail)}
                        >
                          {movingIds.has(email.id)
                            ? <Loader2 className="w-3 h-3 animate-spin" />
                            : <><Inbox className="w-3 h-3" /> Rescue</>}
                        </Button>
                      </div>
                    </Card>
                  ))}
                </div>
              )}

              {junkResult.rescued.length === 0 && (
                <div className="bg-green-950/20 border border-green-800/40 rounded-xl p-4 text-sm text-green-300 flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4" /> No important emails in Junk — looks good.
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
