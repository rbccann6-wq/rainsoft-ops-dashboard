import { useState, useEffect, useCallback } from 'react'
import { DollarSign, RefreshCw, Loader2, AlertCircle, Activity } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'

interface PeriodSummary {
  totalCostUsd: number
  inputTokens: number
  outputTokens: number
  calls: number
}

interface AgentSummary {
  agent: string
  model: string
  totalCostUsd: number
  inputTokens: number
  outputTokens: number
  calls: number
  lastSeen: string | null
}

interface UsageData {
  today: PeriodSummary
  week: PeriodSummary
  month: PeriodSummary
  allTime: PeriodSummary
  byAgent: AgentSummary[]
  recentEntries: any[]
  lastUpdated: string | null
}

const AGENT_EMOJIS: Record<string, string> = {
  rex: '👑', forge: '💻', amp: '📣', scout: '🔬', inbox: '📬',
}

function formatCost(usd: number) {
  if (usd < 0.01) return `$${(usd * 100).toFixed(4)}¢`
  return `$${usd.toFixed(4)}`
}

function formatTokens(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

const MAX_RETRIES = 3
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: Error = new Error('Unknown')
  for (let i = 1; i <= MAX_RETRIES; i++) {
    try { return await fn() } catch (e) {
      lastErr = e as Error
      if (i < MAX_RETRIES) await new Promise(r => setTimeout(r, 1000 * i))
    }
  }
  throw lastErr
}

export function CostMonitor() {
  const [data, setData] = useState<UsageData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [period, setPeriod] = useState<'today' | 'week' | 'month' | 'allTime'>('today')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const resp = await withRetry(async () => {
        const r = await fetch('/api/usage')
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
      })
      setData(resp)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const summary = data?.[period]
  const periods = [
    { key: 'today' as const, label: 'Today' },
    { key: 'week' as const, label: '7 Days' },
    { key: 'month' as const, label: '30 Days' },
    { key: 'allTime' as const, label: 'All Time' },
  ]

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <DollarSign className="w-5 h-5 text-green-400" />
          <h2 className="text-lg font-semibold text-white">Agent Cost Monitor</h2>
        </div>
        <Button variant="ghost" size="sm" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />}
          <span className="hidden sm:inline">Refresh</span>
        </Button>
      </div>

      {error && (
        <div className="flex items-start gap-3 bg-red-950/40 border border-red-700 rounded-xl p-4">
          <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-sm font-semibold text-red-300">Failed to load usage data</p>
            <p className="text-xs text-slate-400 mt-0.5">{error}</p>
          </div>
          <Button variant="ghost" size="sm" onClick={load} className="ml-auto">Retry</Button>
        </div>
      )}

      {loading && !data && (
        <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading usage data…</span>
        </div>
      )}

      {data && (
        <>
          {/* Period tabs */}
          <div className="flex gap-1 border-b border-slate-800">
            {periods.map(p => (
              <button key={p.key} onClick={() => setPeriod(p.key)}
                className={cn('px-4 py-2 text-sm font-medium border-b-2 transition-colors',
                  period === p.key ? 'border-green-500 text-white' : 'border-transparent text-slate-400 hover:text-slate-300'
                )}>{p.label}</button>
            ))}
          </div>

          {/* Summary cards */}
          {summary && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Card><div className="p-4 text-center">
                <p className="text-xs text-slate-500 mb-1">Total Cost</p>
                <p className="text-2xl font-bold font-mono text-green-400">{formatCost(summary.totalCostUsd)}</p>
              </div></Card>
              <Card><div className="p-4 text-center">
                <p className="text-xs text-slate-500 mb-1">API Calls</p>
                <p className="text-2xl font-bold text-white">{summary.calls.toLocaleString()}</p>
              </div></Card>
              <Card><div className="p-4 text-center">
                <p className="text-xs text-slate-500 mb-1">Input Tokens</p>
                <p className="text-2xl font-bold text-white">{formatTokens(summary.inputTokens)}</p>
              </div></Card>
              <Card><div className="p-4 text-center">
                <p className="text-xs text-slate-500 mb-1">Output Tokens</p>
                <p className="text-2xl font-bold text-white">{formatTokens(summary.outputTokens)}</p>
              </div></Card>
            </div>
          )}

          {/* By agent */}
          {data.byAgent.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs text-slate-500 font-medium uppercase tracking-wide">By Agent</p>
              {data.byAgent.map(agent => (
                <Card key={agent.agent}>
                  <div className="p-4 flex items-center gap-4">
                    <div className="text-2xl">{AGENT_EMOJIS[agent.agent] ?? '🤖'}</div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-semibold text-white capitalize">{agent.agent}</p>
                        <span className="text-xs text-slate-500">{agent.model}</span>
                      </div>
                      <p className="text-xs text-slate-500 mt-0.5">
                        {agent.calls} calls · {formatTokens(agent.inputTokens)} in · {formatTokens(agent.outputTokens)} out
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-base font-bold font-mono text-green-400">{formatCost(agent.totalCostUsd)}</p>
                      {agent.lastSeen && (
                        <p className="text-xs text-slate-600 mt-0.5">
                          {new Date(agent.lastSeen).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          ) : (
            <Card>
              <div className="p-8 text-center space-y-2">
                <Activity className="w-8 h-8 text-slate-600 mx-auto" />
                <p className="text-white font-medium">No usage logged yet</p>
                <p className="text-sm text-slate-400">
                  Usage will appear here as agents run. Each session logs token counts and calculates cost automatically.
                </p>
              </div>
            </Card>
          )}

          {data.lastUpdated && (
            <p className="text-xs text-slate-600 text-center">
              Last updated {new Date(data.lastUpdated).toLocaleString()}
            </p>
          )}
        </>
      )}
    </div>
  )
}
