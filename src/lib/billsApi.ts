const BASE = '/api'
const MAX_RETRIES = 3

export interface Bill {
  id: string
  vendor: string
  senderEmail: string
  subject: string
  amount: number | null
  category: 'Business' | 'Personal' | 'Insurance' | 'Other'
  type: 'invoice' | 'subscription' | 'statement' | 'invoice'
  date: string
  preview: string
  isRecurring: boolean
  occurrences: number
}

export interface BillsSummary {
  total: number
  recurring: number
  estimatedMonthlySpend: number
  byCategory: { Business: number; Personal: number; Insurance: number; Other: number }
}

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: Error = new Error('Unknown')
  for (let i = 1; i <= MAX_RETRIES; i++) {
    try { return await fn() } catch (err) {
      lastErr = err as Error
      if (i < MAX_RETRIES) await new Promise(r => setTimeout(r, 1000 * i))
    }
  }
  throw new Error(`${label} failed after ${MAX_RETRIES} attempts: ${lastErr.message}`)
}

export async function fetchBills(): Promise<{ bills: Bill[]; summary: BillsSummary }> {
  return withRetry(async () => {
    const resp = await fetch(`${BASE}/bills`)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    return resp.json()
  }, 'fetchBills')
}
