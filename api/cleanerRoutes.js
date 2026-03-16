/**
 * Email Cleaner Routes
 * Server-side bulk sender analysis + delete across all 60k emails.
 * Never touches emails from safe/business senders.
 */

import express from 'express'
import { ConfidentialClientApplication } from '@azure/msal-node'

const router = express.Router()

const msalClient = new ConfidentialClientApplication({
  auth: {
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    authority: `https://login.microsoftonline.com/${process.env.TENANT_ID}`,
  },
})

async function getToken() {
  const r = await msalClient.acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  })
  if (!r?.accessToken) throw new Error('Failed to acquire token')
  return r.accessToken
}

async function withRetry(fn, label, max = 3) {
  let err
  for (let i = 1; i <= max; i++) {
    try { return await fn() } catch (e) {
      err = e
      if (i < max) await new Promise(r => setTimeout(r, 1000 * i))
    }
  }
  throw new Error(`[${label}] failed after ${max} attempts: ${err.message}`)
}

async function graphGet(path, token) {
  const r = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`Graph GET ${path} → ${r.status}: ${t}`)
  }
  return r.json()
}

async function graphDelete(path, token) {
  const r = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  })
  if (r.status !== 204 && !r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`Graph DELETE ${path} → ${r.status}: ${t}`)
  }
}

async function graphPost(path, token, body) {
  const r = await fetch(`https://graph.microsoft.com/v1.0${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) {
    const t = await r.text().catch(() => '')
    throw new Error(`Graph POST ${path} → ${r.status}: ${t}`)
  }
  return r.json()
}

// ─── Safe senders — NEVER delete these ───────────────────────────────────────

const SAFE_DOMAINS = new Set([
  'rainsoftse.com', 'rainsoft.com', 'pentair.com', 'dialpad.com',
  'salesforce.com', 'docusign.net', 'docusign.com', 'fastfieldforms.com',
  'rippling.com', 'loweshomeservices.com', 'imeinc.com', 'trustedhomeservices.com',
  'homedepot.com', 'smartmailgroup.com', 'microsoft.com', 'microsoftonline.com',
  'aflac.com', 'accounts.google.com', 'wellsfargo.com', 'americanexpress.com',
  'welcome.americanexpress.com', 'squareup.com', 'legal.squareup.com',
  'notify.wellsfargo.com', 'accountprotection.microsoft.com', 'docusign.net',
  'account-security-noreply@accountprotection.microsoft.com',
])

function getDomain(email) {
  return email?.split('@')[1]?.toLowerCase() ?? ''
}

function isSafe(senderEmail) {
  const domain = getDomain(senderEmail)
  return SAFE_DOMAINS.has(domain)
}

// ─── GET /api/cleaner/senders — scan all emails, group by sender ──────────────
// This paginates through ALL inbox mail server-side and returns sender groups.

router.get('/cleaner/senders', async (req, res) => {
  try {
    const token = await withRetry(getToken, 'token')
    const mailbox = process.env.MAILBOX_EMAIL
    const senderMap = {} // email -> { name, email, domain, count, safe, ids[], sample[] }

    let url = `https://graph.microsoft.com/v1.0/users/${mailbox}/messages?` +
      `$top=1000&$select=id,from,subject,receivedDateTime,isRead&$orderby=receivedDateTime desc`

    let pageCount = 0
    const MAX_PAGES = 100 // max 100k emails

    while (url && pageCount < MAX_PAGES) {
      const data = await withRetry(async () => {
        const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        if (!r.ok) throw new Error(`Graph ${r.status}`)
        return r.json()
      }, `page-${pageCount}`)

      for (const msg of data.value || []) {
        const addr = msg.from?.emailAddress?.address?.toLowerCase() ?? 'unknown'
        const name = msg.from?.emailAddress?.name ?? addr
        const domain = getDomain(addr)

        if (!senderMap[addr]) {
          senderMap[addr] = {
            name,
            email: addr,
            domain,
            count: 0,
            safe: isSafe(addr),
            ids: [],
            samples: [],
          }
        }
        senderMap[addr].count++
        // Keep up to 50 IDs for bulk delete (we'll fetch more on demand)
        if (senderMap[addr].ids.length < 500) senderMap[addr].ids.push(msg.id)
        if (senderMap[addr].samples.length < 3) {
          senderMap[addr].samples.push({
            subject: msg.subject,
            date: msg.receivedDateTime,
          })
        }
      }

      url = data['@odata.nextLink'] ?? null
      pageCount++
    }

    // Sort by count desc
    const senders = Object.values(senderMap).sort((a, b) => b.count - a.count)

    res.json({
      senders,
      totalScanned: senders.reduce((s, x) => s + x.count, 0),
      totalSenders: senders.length,
      pagesScanned: pageCount,
    })
  } catch (err) {
    console.error('GET /api/cleaner/senders:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── POST /api/cleaner/delete-sender — delete all emails from a sender ────────

router.post('/cleaner/delete-sender', async (req, res) => {
  const { senderEmail } = req.body
  if (!senderEmail) return res.status(400).json({ error: 'senderEmail required' })
  if (isSafe(senderEmail)) return res.status(403).json({ error: 'Refusing to delete emails from safe sender' })

  try {
    const token = await withRetry(getToken, 'token')
    const mailbox = process.env.MAILBOX_EMAIL

    let deleted = 0
    let failed = 0
    let url = `https://graph.microsoft.com/v1.0/users/${mailbox}/messages?` +
      `$filter=from/emailAddress/address eq '${senderEmail.replace(/'/g, "''")}'&$top=100&$select=id`

    while (url) {
      const data = await withRetry(async () => {
        const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
        if (!r.ok) throw new Error(`Graph ${r.status}`)
        return r.json()
      }, 'fetch-batch')

      const ids = (data.value || []).map(m => m.id)
      if (ids.length === 0) break

      // Delete in batches of 20 using Graph $batch
      for (let i = 0; i < ids.length; i += 20) {
        const batch = ids.slice(i, i + 20)
        const requests = batch.map((id, idx) => ({
          id: String(idx + 1),
          method: 'DELETE',
          url: `/users/${mailbox}/messages/${id}`,
        }))

        try {
          await withRetry(async () => {
            const r = await fetch('https://graph.microsoft.com/v1.0/$batch', {
              method: 'POST',
              headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ requests }),
            })
            if (!r.ok) throw new Error(`Batch ${r.status}`)
            const result = await r.json()
            for (const resp of result.responses || []) {
              if (resp.status >= 200 && resp.status < 300) deleted++
              else failed++
            }
          }, 'batch-delete')
        } catch {
          failed += batch.length
        }

        // Brief pause to respect throttling
        await new Promise(r => setTimeout(r, 100))
      }

      url = data['@odata.nextLink'] ?? null
    }

    res.json({ deleted, failed })
  } catch (err) {
    console.error('POST /api/cleaner/delete-sender:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/cleaner/junk — emails in Junk that look like they shouldn't be ──

router.get('/cleaner/junk', async (req, res) => {
  try {
    const token = await withRetry(getToken, 'token')
    const mailbox = process.env.MAILBOX_EMAIL

    const data = await withRetry(async () => {
      const r = await fetch(
        `https://graph.microsoft.com/v1.0/users/${mailbox}/mailFolders/junkemail/messages?` +
        `$top=200&$select=id,from,subject,receivedDateTime,isRead&$orderby=receivedDateTime desc`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (!r.ok) throw new Error(`Graph ${r.status}`)
      return r.json()
    }, 'fetch-junk')

    const msgs = data.value || []

    // Flag any that are from safe senders (shouldn't be in junk)
    const rescued = msgs
      .filter(m => isSafe(m.from?.emailAddress?.address ?? ''))
      .map(m => ({
        id: m.id,
        sender: m.from?.emailAddress?.name ?? '',
        senderEmail: m.from?.emailAddress?.address ?? '',
        subject: m.subject,
        date: m.receivedDateTime,
      }))

    const junk = msgs
      .filter(m => !isSafe(m.from?.emailAddress?.address ?? ''))
      .map(m => ({
        id: m.id,
        sender: m.from?.emailAddress?.name ?? '',
        senderEmail: m.from?.emailAddress?.address ?? '',
        subject: m.subject,
        date: m.receivedDateTime,
      }))

    res.json({ rescued, junk, total: msgs.length })
  } catch (err) {
    console.error('GET /api/cleaner/junk:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── POST /api/cleaner/move-to-inbox — rescue email from junk ─────────────────

router.post('/cleaner/move-to-inbox', async (req, res) => {
  const { messageId } = req.body
  if (!messageId) return res.status(400).json({ error: 'messageId required' })

  try {
    const token = await withRetry(getToken, 'token')
    const mailbox = process.env.MAILBOX_EMAIL

    await withRetry(() =>
      graphPost(`/users/${mailbox}/messages/${messageId}/move`, token, { destinationId: 'inbox' }),
      'move-to-inbox'
    )
    res.json({ success: true })
  } catch (err) {
    console.error('POST /api/cleaner/move-to-inbox:', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router
