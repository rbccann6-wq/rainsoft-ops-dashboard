import type { Email } from '@/types'

const BASE = '/api'

export async function fetchEmails(): Promise<Email[]> {
  const resp = await fetch(`${BASE}/emails`)
  if (!resp.ok) throw new Error(`Failed to fetch emails: ${resp.status}`)
  return resp.json()
}

export async function fetchEmail(id: string): Promise<Email> {
  const resp = await fetch(`${BASE}/emails/${id}`)
  if (!resp.ok) throw new Error(`Failed to fetch email ${id}: ${resp.status}`)
  return resp.json()
}

export async function createDraftReply(
  emailId: string,
  body: string,
): Promise<{ draftId: string }> {
  const resp = await fetch(`${BASE}/emails/${emailId}/draft-reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  })
  if (!resp.ok) throw new Error(`Failed to create draft reply: ${resp.status}`)
  return resp.json()
}

export async function sendReply(draftId: string): Promise<void> {
  const resp = await fetch(`${BASE}/emails/${draftId}/send-reply`, {
    method: 'POST',
  })
  if (!resp.ok) throw new Error(`Failed to send reply: ${resp.status}`)
}
