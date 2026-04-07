/**
 * FastField Email Poller
 * 
 * Since Microsoft Graph webhooks can't reach Render through Cloudflare,
 * we use delta polling: check for new FastField emails every 5 minutes.
 * Uses /messages/delta to only fetch emails since last check — very efficient.
 */

import express from 'express'
import { ConfidentialClientApplication } from '@azure/msal-node'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const router = express.Router()

const FASTFIELD_SENDER  = 'noreply@fastfieldforms.com'
const DELTA_TOKEN_PATH  = path.join(__dirname, '..', 'data', 'delta-token.json')
const PROCESSED_PATH    = path.join(__dirname, '..', 'data', 'processed-emails.json')
const POLL_INTERVAL_MS  = 5 * 60 * 1000  // 5 minutes

let _msalClient = null
function getMsalClient() {
  if (!_msalClient) {
    _msalClient = new ConfidentialClientApplication({
      auth: {
        clientId:  process.env.CLIENT_ID,
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

// ── Delta token persistence ───────────────────────────────────────────────────

function loadDeltaToken() {
  try {
    if (fs.existsSync(DELTA_TOKEN_PATH)) {
      return JSON.parse(fs.readFileSync(DELTA_TOKEN_PATH, 'utf8')).deltaToken || null
    }
  } catch {}
  return null
}

function saveDeltaToken(token) {
  fs.mkdirSync(path.dirname(DELTA_TOKEN_PATH), { recursive: true })
  fs.writeFileSync(DELTA_TOKEN_PATH, JSON.stringify({ deltaToken: token, savedAt: new Date().toISOString() }))
}

function loadProcessed() {
  try {
    if (fs.existsSync(PROCESSED_PATH)) return new Set(JSON.parse(fs.readFileSync(PROCESSED_PATH, 'utf8')))
  } catch {}
  return new Set()
}

function saveProcessed(ids) {
  fs.mkdirSync(path.dirname(PROCESSED_PATH), { recursive: true })
  fs.writeFileSync(PROCESSED_PATH, JSON.stringify([...ids]))
}

// ── Alert helper ──────────────────────────────────────────────────────────────

import { execSync } from 'child_process'

function alert(text) {
  try {
    execSync(`openclaw system event --text "${text.replace(/"/g, "'")}" --mode now`, { timeout: 10000 })
  } catch {}
}

// ── Core poll logic ───────────────────────────────────────────────────────────

let pollerState = {
  running: false,
  lastPoll: null,
  lastError: null,
  emailsFound: 0,
}

async function pollOnce() {
  const mailbox = process.env.MAILBOX_EMAIL
  if (!mailbox) return

  const token = await getToken()
  const deltaToken = loadDeltaToken()
  const processed = loadProcessed()

  const port = process.env.PORT || 3000
  const BASE = `https://graph.microsoft.com/v1.0`

  // Build URL: delta query for inbox messages
  let url = deltaToken
    ? `${BASE}/users/${mailbox}/mailFolders/Inbox/messages/delta?$deltaToken=${deltaToken}&$select=id,subject,from,hasAttachments,receivedDateTime`
    : `${BASE}/users/${mailbox}/mailFolders/Inbox/messages/delta?$select=id,subject,from,hasAttachments,receivedDateTime&$orderby=receivedDateTime+desc`

  const newMessages = []
  let nextDeltaToken = null

  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!r.ok) throw new Error(`Graph ${r.status}: ${await r.text()}`)
    const data = await r.json()

    for (const msg of data.value || []) {
      const sender = msg.from?.emailAddress?.address?.toLowerCase()
      if (sender === FASTFIELD_SENDER && !processed.has(msg.id)) {
        newMessages.push(msg)
      }
    }

    // Extract delta token from @odata.deltaLink
    if (data['@odata.deltaLink']) {
      const match = data['@odata.deltaLink'].match(/\$deltaToken=([^&]+)/)
      if (match) nextDeltaToken = match[1]
      url = null
    } else {
      url = data['@odata.nextLink'] || null
    }
  }

  if (nextDeltaToken) saveDeltaToken(nextDeltaToken)

  console.log(`[poller] Poll complete: ${newMessages.length} new FastField email(s)`)

  for (const msg of newMessages) {
    processed.add(msg.id)
    saveProcessed(processed)
    pollerState.emailsFound++

    try {
      // Notify the webhook handler (same logic, reuse processNotification)
      await fetch(`http://localhost:${port}/api/webhooks/process`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId: msg.id, subject: msg.subject }),
      })
    } catch (err) {
      console.error('[poller] Failed to process message:', msg.id, err.message)
      alert(`❌ FastField email arrived but processing failed: ${err.message}`)
    }
  }

  // Also run finance email → CRM linker on each poll cycle
  try {
    const port2 = process.env.PORT || 3000
    const linkR = await fetch(`http://localhost:${port2}/api/finance-emails/link-to-crm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })
    if (linkR.ok) {
      const linkResult = await linkR.json()
      if (linkResult.linked > 0) {
        console.log(`[poller] CRM linker: ${linkResult.linked} emails linked, ${linkResult.filesUploaded} files uploaded`)
      }
    }
  } catch (err) {
    console.error('[poller] CRM linker failed:', err.message)
  }

  pollerState.lastPoll = new Date().toISOString()
  pollerState.lastError = null
}

// ── Start/stop poller ─────────────────────────────────────────────────────────

let pollInterval = null

export function startPoller() {
  if (pollInterval) return
  console.log(`[poller] Starting FastField email poller (every ${POLL_INTERVAL_MS / 60000} min)`)

  const run = async () => {
    try {
      await pollOnce()
    } catch (err) {
      pollerState.lastError = err.message
      console.error('[poller] Poll failed:', err.message)
    }
  }

  // Run immediately, then on interval
  run()
  pollInterval = setInterval(run, POLL_INTERVAL_MS)
}

export function stopPoller() {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
    console.log('[poller] Stopped')
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/poller/status', (req, res) => {
  res.json({
    ...pollerState,
    active: !!pollInterval,
    intervalMinutes: POLL_INTERVAL_MS / 60000,
  })
})

router.post('/poller/poll-now', async (req, res) => {
  try {
    await pollOnce()
    res.json({ ok: true, lastPoll: pollerState.lastPoll })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

export default router
