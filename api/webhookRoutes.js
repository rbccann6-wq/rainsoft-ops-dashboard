/**
 * Microsoft Graph Webhook Routes
 *
 * Handles real-time email notifications from Microsoft Graph.
 * When a FastField credit app email arrives, Graph POSTs here instantly.
 * No polling needed.
 *
 * Flow:
 *   1. On server start → register/renew Graph subscription for FastField emails
 *   2. Graph validates endpoint via GET with validationToken
 *   3. Graph POSTs notification when new email arrives
 *   4. We download PDF, parse fields, run finance agent, alert Rebecca
 *
 * Subscription renewal: Graph subscriptions expire every 3 days max.
 * We auto-renew every 2 days to stay ahead.
 */

import express from 'express'
import { ConfidentialClientApplication } from '@azure/msal-node'
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const router = express.Router()

const FASTFIELD_SENDER = 'noreply@fastfieldforms.com'
const SUBSCRIPTION_CACHE = path.join(__dirname, '..', 'data', 'graph-subscription.json')
const PROCESSED_IDS_PATH = path.join(__dirname, '..', 'data', 'processed-emails.json')
const PDF_DIR = path.join(__dirname, '..', 'data', 'pdfs')
const MAX_RETRIES = 3

// ── MSAL client ───────────────────────────────────────────────────────────────

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
  if (!r?.accessToken) throw new Error('Failed to acquire M365 token')
  return r.accessToken
}

async function withRetry(fn, label, max = MAX_RETRIES) {
  let err
  for (let i = 1; i <= max; i++) {
    try { return await fn() } catch (e) {
      err = e
      if (i < max) await new Promise(r => setTimeout(r, 1500 * i))
    }
  }
  throw new Error(`[${label}] failed after ${max} attempts: ${err.message}`)
}

// ── Processed email tracking ──────────────────────────────────────────────────

function loadProcessed() {
  try {
    if (fs.existsSync(PROCESSED_IDS_PATH)) {
      return new Set(JSON.parse(fs.readFileSync(PROCESSED_IDS_PATH, 'utf8')))
    }
  } catch {}
  return new Set()
}

function saveProcessed(ids) {
  fs.mkdirSync(path.dirname(PROCESSED_IDS_PATH), { recursive: true })
  fs.writeFileSync(PROCESSED_IDS_PATH, JSON.stringify([...ids]))
}

const processedIds = loadProcessed()

// ── Graph subscription management ────────────────────────────────────────────

function loadSubscription() {
  try {
    if (fs.existsSync(SUBSCRIPTION_CACHE)) {
      return JSON.parse(fs.readFileSync(SUBSCRIPTION_CACHE, 'utf8'))
    }
  } catch {}
  return null
}

function saveSubscription(sub) {
  fs.mkdirSync(path.dirname(SUBSCRIPTION_CACHE), { recursive: true })
  fs.writeFileSync(SUBSCRIPTION_CACHE, JSON.stringify(sub, null, 2))
}

async function createSubscription(token) {
  const notificationUrl = `${process.env.PUBLIC_URL}/api/webhooks/graph`
  const mailbox = process.env.MAILBOX_EMAIL

  // Expiry: 3 days max for mail subscriptions (Graph limit)
  const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 - 60000).toISOString()

  const body = {
    changeType: 'created',
    notificationUrl,
    resource: `/users/${mailbox}/messages`,
    expirationDateTime: expiresAt,
    clientState: process.env.WEBHOOK_SECRET || 'rainsoft-webhook-secret',
    // Filter to FastField emails only
    // Note: Graph doesn't support sender filter in subscriptions directly —
    // we filter on receipt in the notification handler
  }

  const r = await fetch('https://graph.microsoft.com/v1.0/subscriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!r.ok) {
    const text = await r.text()
    throw new Error(`Create subscription failed: ${r.status} ${text}`)
  }

  const sub = await r.json()
  console.log(`[webhook] Subscription created: ${sub.id} (expires ${sub.expirationDateTime})`)
  saveSubscription(sub)
  return sub
}

async function renewSubscription(token, subId) {
  const expiresAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 - 60000).toISOString()

  const r = await fetch(`https://graph.microsoft.com/v1.0/subscriptions/${subId}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expirationDateTime: expiresAt }),
  })

  if (!r.ok) {
    const text = await r.text()
    throw new Error(`Renew subscription failed: ${r.status} ${text}`)
  }

  const sub = await r.json()
  console.log(`[webhook] Subscription renewed: ${sub.id} (expires ${sub.expirationDateTime})`)
  saveSubscription(sub)
  return sub
}

export async function ensureSubscription() {
  if (!process.env.PUBLIC_URL) {
    console.warn('[webhook] PUBLIC_URL not set — skipping Graph subscription registration')
    return
  }

  try {
    const token = await withRetry(getToken, 'get-token')
    const existing = loadSubscription()

    if (existing) {
      const expiresAt = new Date(existing.expirationDateTime)
      const renewThreshold = new Date(Date.now() + 24 * 60 * 60 * 1000) // renew if <24h left

      if (expiresAt > renewThreshold) {
        console.log(`[webhook] Subscription ${existing.id} still valid until ${expiresAt.toISOString()}`)
        return
      }

      // Renew
      try {
        await withRetry(() => renewSubscription(token, existing.id), 'renew-subscription')
        return
      } catch (err) {
        console.warn(`[webhook] Renewal failed, creating new subscription: ${err.message}`)
      }
    }

    await withRetry(() => createSubscription(token), 'create-subscription')
  } catch (err) {
    console.error(`[webhook] Failed to ensure subscription: ${err.message}`)
  }
}

// ── Finance agent run logger ─────────────────────────────────────────────────

async function logRun(data) {
  try {
    const port = process.env.PORT || 3000
    await fetch(`http://localhost:${port}/api/finance-agent/log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    })
  } catch (e) {
    console.warn('[webhook] logRun failed:', e.message)
  }
}

// ── Alert helper ──────────────────────────────────────────────────────────────

function alert(text) {
  try {
    execSync(`openclaw system event --text "${text.replace(/"/g, "'")}" --mode now`, { timeout: 10000 })
  } catch (e) {
    console.warn('[webhook] Alert failed:', e.message)
  }
}

// ── Download PDF attachment ───────────────────────────────────────────────────

async function downloadPdf(token, messageId) {
  const mailbox = process.env.MAILBOX_EMAIL

  const r = await fetch(
    `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${messageId}/attachments`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!r.ok) throw new Error(`List attachments: ${r.status}`)
  const data = await r.json()

  const pdf = (data.value || []).find(a =>
    a.name?.toLowerCase().endsWith('.pdf') || a.contentType === 'application/pdf'
  )
  if (!pdf) throw new Error('No PDF attachment found in FastField email')

  const r2 = await fetch(
    `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${messageId}/attachments/${pdf.id}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!r2.ok) throw new Error(`Download attachment: ${r2.status}`)
  const att = await r2.json()

  fs.mkdirSync(PDF_DIR, { recursive: true })
  const pdfPath = path.join(PDF_DIR, `${Date.now()}-${messageId.slice(-8)}.pdf`)
  fs.writeFileSync(pdfPath, Buffer.from(att.contentBytes, 'base64'))
  return pdfPath
}

// ── Fetch full message to check sender ───────────────────────────────────────

async function getMessage(token, messageId) {
  const mailbox = process.env.MAILBOX_EMAIL
  const r = await fetch(
    `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${messageId}?$select=id,subject,from,hasAttachments,receivedDateTime`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!r.ok) throw new Error(`Get message: ${r.status}`)
  return r.json()
}

// ── Process a FastField notification ─────────────────────────────────────────

async function processNotification(messageId) {
  if (processedIds.has(messageId)) {
    console.log(`[webhook] Already processed ${messageId} — skipping`)
    return
  }
  processedIds.add(messageId)
  saveProcessed(processedIds)

  const token = await withRetry(getToken, 'get-token')

  // Fetch message to confirm sender
  let msg
  try {
    msg = await withRetry(() => getMessage(token, messageId), 'get-message')
  } catch (err) {
    console.error(`[webhook] Could not fetch message ${messageId}:`, err.message)
    return
  }

  const sender = msg.from?.emailAddress?.address?.toLowerCase()
  if (sender !== FASTFIELD_SENDER) {
    console.log(`[webhook] Ignoring message from ${sender} (not FastField)`)
    return
  }

  if (!msg.hasAttachments) {
    console.warn(`[webhook] FastField email has no attachments — subject: ${msg.subject}`)
    alert(`⚠️ FastField email arrived with no PDF attachment. Check inbox manually. Subject: ${msg.subject}`)
    return
  }

  console.log(`[webhook] Processing FastField credit app: ${msg.subject}`)

  // Download PDF
  let pdfPath
  try {
    pdfPath = await withRetry(() => downloadPdf(token, messageId), 'download-pdf')
    console.log(`[webhook] PDF downloaded: ${pdfPath}`)
  } catch (err) {
    console.error(`[webhook] PDF download failed:`, err.message)
    alert(`❌ FastField credit app received but PDF download failed: ${err.message}. Check email manually.`)
    return
  }

  // Parse + run agent (dynamic import — finance-agent may not be available on Render yet)
  try {
    let parsePdf, runAgent
    try {
      const financeAgentPath = process.env.FINANCE_AGENT_PATH || '/Users/rebeccasbot/Projects/finance-agent'
      const parserMod = await import(`${financeAgentPath}/src/pdfParser.js`)
      const agentMod = await import(`${financeAgentPath}/src/agent.js`)
      parsePdf = parserMod.parsePdf
      runAgent = agentMod.runAgent
    } catch (importErr) {
      console.warn('[webhook] Finance agent not available — alerting for manual review:', importErr.message)
      alert(`📋 FastField credit app received for manual processing. Finance agent not available on this server. Check email for PDF.`)
      return
    }

    const app = parsePdf(pdfPath)
    const name = `${app.firstName} ${app.lastName}`
    const amount = `$${app.saleAmount.toLocaleString()}`
    console.log(`[webhook] Parsed app: ${name} | ${amount} | ${app.leadSource}`)

    // ── APPROVAL MODE: validate + route, but DO NOT submit yet ──────────────
    // Run validator to catch hard stops
    const { validate } = await import(`${process.env.FINANCE_AGENT_PATH || '/Users/rebeccasbot/Projects/finance-agent'}/src/validator.js`)
    const { route }    = await import(`${process.env.FINANCE_AGENT_PATH || '/Users/rebeccasbot/Projects/finance-agent'}/src/router.js`)

    const validation = validate(app)
    const routing    = route(app)

    const runId = `${messageId}-${Date.now()}`

    if (!validation.ok) {
      // Hard stop — alert Rebecca, log as stopped, wait for manual review
      const stops = validation.stops.join(' | ')
      alert(`🛑 CREDIT APP NEEDS REVIEW — ${name} (${amount})\n${stops}\n\nCheck Finance Agent tab to approve or reject.`)
      await logRun({
        run_id: runId, applicant_name: name,
        co_applicant_name: app.coApp?.firstName ? `${app.coApp.firstName} ${app.coApp.lastName}` : null,
        sale_amount: app.saleAmount, amount_financed: app.amountFinanced,
        product: app.product, lead_source: app.leadSource, promo: app.promo,
        portal: routing.portal, status: 'stopped', stops: validation.stops,
        sales_rep: app.salesRep, install_date: app.installDate,
        email_subject: msg.subject, email_received_at: msg.receivedDateTime,
      })
      return
    }

    if (routing.skip) {
      // HD/Lowe's — customer self-submits, just notify
      alert(`📋 Credit app received for ${name} (${amount}) — ${routing.skipReason}`)
      await logRun({
        run_id: runId, applicant_name: name,
        co_applicant_name: app.coApp?.firstName ? `${app.coApp.firstName} ${app.coApp.lastName}` : null,
        sale_amount: app.saleAmount, amount_financed: app.amountFinanced,
        product: app.product, lead_source: app.leadSource, promo: app.promo,
        portal: null, status: 'skipped', skip_reason: routing.skipReason,
        sales_rep: app.salesRep, install_date: app.installDate,
        email_subject: msg.subject, email_received_at: msg.receivedDateTime,
      })
      return
    }

    // ── PENDING APPROVAL — alert Rebecca to review + approve in dashboard ────
    const portalName = (routing.portal || 'ISPC').toUpperCase()
    alert(`📥 New credit app ready for review — ${name} (${amount})\nPortal: ${portalName} | Product: ${app.product || '?'}\n\nOpen the Finance Agent tab to approve and submit.`)

    await logRun({
      run_id: runId, applicant_name: name,
      co_applicant_name: app.coApp?.firstName ? `${app.coApp.firstName} ${app.coApp.lastName}` : null,
      sale_amount: app.saleAmount, amount_financed: app.amountFinanced,
      product: app.product, lead_source: app.leadSource, promo: app.promo,
      portal: routing.portal, status: 'pending_approval',
      sales_rep: app.salesRep, install_date: app.installDate,
      email_subject: msg.subject, email_received_at: msg.receivedDateTime,
      result_summary: `Ready to submit to ${portalName} — awaiting your approval`,
    })
  } catch (err) {
    console.error(`[webhook] Agent run failed:`, err.message)
    alert(`❌ Finance agent failed for credit app: ${err.message}. Check logs.`)
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/webhooks/graph — Graph validation handshake
router.get('/webhooks/graph', (req, res) => {
  const { validationToken } = req.query
  if (validationToken) {
    console.log('[webhook] Graph validation handshake received')
    return res.set('Content-Type', 'text/plain').send(validationToken)
  }
  res.status(400).send('Missing validationToken')
})

// POST /api/webhooks/graph — incoming Graph notification
router.post('/webhooks/graph', express.json(), async (req, res) => {
  // Acknowledge immediately — Graph requires response within 3s
  res.status(202).send()

  const notifications = req.body?.value || []
  for (const n of notifications) {
    // Validate client state
    const expectedSecret = process.env.WEBHOOK_SECRET || 'rainsoft-webhook-secret'
    if (n.clientState !== expectedSecret) {
      console.warn('[webhook] Invalid clientState — ignoring notification')
      continue
    }

    const resourceData = n.resourceData
    const messageId = resourceData?.id || n.resource?.split('/messages/')?.[1]?.split('/')?.[0]

    if (!messageId) {
      console.warn('[webhook] Could not extract message ID from notification')
      continue
    }

    // Process async (don't block the response)
    processNotification(messageId).catch(err =>
      console.error('[webhook] processNotification error:', err.message)
    )
  }
})

// GET /api/webhooks/status — check subscription status
router.get('/webhooks/status', (req, res) => {
  const sub = loadSubscription()
  if (!sub) return res.json({ subscribed: false })
  const expiresAt = new Date(sub.expirationDateTime)
  const hoursLeft = Math.round((expiresAt - Date.now()) / (1000 * 60 * 60))
  res.json({
    subscribed: true,
    subscriptionId: sub.id,
    expiresAt: sub.expirationDateTime,
    hoursLeft,
    healthy: hoursLeft > 0,
  })
})

// POST /api/webhooks/renew — manual renew trigger
router.post('/webhooks/renew', async (req, res) => {
  try {
    await ensureSubscription()
    const sub = loadSubscription()
    res.json({ ok: true, expiresAt: sub?.expirationDateTime })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

export default router
