/**
 * Safelist Routes
 * Persists user-approved senders so they never get flagged as spam again.
 * Also attempts to add to M365 Safe Senders list.
 */

import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ConfidentialClientApplication } from '@azure/msal-node'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SAFELIST_PATH = path.join(__dirname, '..', 'data', 'safelist.json')

const router = express.Router()

let _msalClient = null
function getMsalClient() {
  if (!_msalClient) {
    _msalClient = new ConfidentialClientApplication({
      auth: {
        clientId: process.env.CLIENT_ID,
        clientSecret: process.env.CLIENT_SECRET,
        authority: `https://login.microsoftonline.com/${process.env.TENANT_ID}`,
      },
    })
  }
  return _msalClient
}

async function getToken() {
  const r = await getMsalClient().acquireTokenByClientCredential({
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

// ─── Safelist file helpers ────────────────────────────────────────────────────

function loadSafelist() {
  try {
    if (!fs.existsSync(SAFELIST_PATH)) return { emails: [], domains: [] }
    return JSON.parse(fs.readFileSync(SAFELIST_PATH, 'utf8'))
  } catch { return { emails: [], domains: [] } }
}

function saveSafelist(data) {
  fs.mkdirSync(path.dirname(SAFELIST_PATH), { recursive: true })
  fs.writeFileSync(SAFELIST_PATH, JSON.stringify(data, null, 2))
}

// ─── GET /api/safelist ────────────────────────────────────────────────────────

router.get('/safelist', (req, res) => {
  res.json(loadSafelist())
})

// ─── POST /api/safelist/add — add sender, move email, never spam again ────────

router.post('/safelist/add', async (req, res) => {
  const { senderEmail, messageId } = req.body
  if (!senderEmail) return res.status(400).json({ error: 'senderEmail required' })

  const results = { safelisted: false, m365SafeSender: false, movedToInbox: false, errors: [] }

  // 1. Add to local safelist file
  try {
    const list = loadSafelist()
    const email = senderEmail.toLowerCase()
    const domain = email.split('@')[1] ?? ''

    if (!list.emails.includes(email)) list.emails.push(email)
    // If same domain has 3+ approved senders, safelist the whole domain
    const domainCount = list.emails.filter(e => e.endsWith('@' + domain)).length
    if (domainCount >= 3 && !list.domains.includes(domain)) list.domains.push(domain)

    saveSafelist(list)
    results.safelisted = true
  } catch (err) {
    results.errors.push(`Local safelist: ${err.message}`)
  }

  // 2. Move message to inbox if messageId provided
  if (messageId) {
    try {
      const token = await withRetry(getToken, 'token')
      const mailbox = process.env.MAILBOX_EMAIL
      const r = await fetch(
        `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${messageId}/move`,
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ destinationId: 'inbox' }),
        }
      )
      if (r.ok) results.movedToInbox = true
      else results.errors.push(`Move to inbox: HTTP ${r.status}`)
    } catch (err) {
      results.errors.push(`Move to inbox: ${err.message}`)
    }
  }

  // 3. Try to add to M365 Safe Senders / Junk Email override
  // Uses inferenceClassification override — marks sender as "focused" (never junk)
  try {
    const token = await withRetry(getToken, 'token')
    const mailbox = process.env.MAILBOX_EMAIL
    const r = await fetch(
      `https://graph.microsoft.com/v1.0/users/${mailbox}/inferenceClassification/overrides`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          classifyAs: 'focused',
          senderEmailAddress: {
            address: senderEmail.toLowerCase(),
          },
        }),
      }
    )
    if (r.ok || r.status === 409) { // 409 = already exists, that's fine
      results.m365SafeSender = true
    } else {
      const text = await r.text().catch(() => '')
      results.errors.push(`M365 override: HTTP ${r.status} ${text.substring(0, 100)}`)
    }
  } catch (err) {
    results.errors.push(`M365 override: ${err.message}`)
  }

  res.json(results)
})

// ─── DELETE /api/safelist/remove ─────────────────────────────────────────────

router.delete('/safelist/remove', async (req, res) => {
  const { senderEmail } = req.body
  if (!senderEmail) return res.status(400).json({ error: 'senderEmail required' })

  try {
    const list = loadSafelist()
    const email = senderEmail.toLowerCase()
    list.emails = list.emails.filter(e => e !== email)
    saveSafelist(list)

    // Also remove M365 override if it exists
    try {
      const token = await withRetry(getToken, 'token')
      const mailbox = process.env.MAILBOX_EMAIL
      // Find the override ID first
      const listResp = await fetch(
        `https://graph.microsoft.com/v1.0/users/${mailbox}/inferenceClassification/overrides`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (listResp.ok) {
        const overrides = await listResp.json()
        const match = (overrides.value || []).find(
          o => o.senderEmailAddress?.address?.toLowerCase() === email
        )
        if (match) {
          await fetch(
            `https://graph.microsoft.com/v1.0/users/${mailbox}/inferenceClassification/overrides/${match.id}`,
            { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } }
          )
        }
      }
    } catch { /* best effort */ }

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
export { loadSafelist }
