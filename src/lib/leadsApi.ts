import type { ImeLead, SmartMailBatch } from '@/types'

const BASE = '/api'
const MAX_RETRIES = 3
const RETRY_DELAY = 1000

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: Error = new Error('Unknown error')
  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err as Error
      if (i < MAX_RETRIES) await new Promise(r => setTimeout(r, RETRY_DELAY * i))
    }
  }
  throw new Error(`${label} failed after ${MAX_RETRIES} attempts: ${lastErr.message}`)
}

export async function fetchImeLeads(): Promise<{ leads: ImeLead[]; errors: string[] }> {
  return withRetry(async () => {
    const resp = await fetch(`${BASE}/leads`)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return resp.json()
  }, 'fetchImeLeads')
}

export async function fetchSmartMailBatches(): Promise<SmartMailBatch[]> {
  return withRetry(async () => {
    const resp = await fetch(`${BASE}/smartmail-leads`)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const data = await resp.json()
    return data.batches ?? []
  }, 'fetchSmartMailBatches')
}
