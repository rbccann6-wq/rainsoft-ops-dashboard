/**
 * Auto-Unsubscribe Agent
 * Scans M365 (rebecca@rainsoftse.com) and Gmail (rbccann6@gmail.com)
 * Finds emails with unsubscribe links/headers and fires them automatically
 * Logs all actions to Supabase unsubscribe_log table
 */

import express from 'express'
import { ConfidentialClientApplication } from '@azure/msal-node'
import { createClient } from '@supabase/supabase-js'
import https from 'https'
import http from 'http'
import { URL } from 'url'

const router = express.Router()

// ── Clients ────────────────────────────────────────────────────────────────────

function getSB() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  )
}

let _msal = null
function getMsal() {
  if (!_msal) _msal = new ConfidentialClientApplication({ auth: {
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    authority: `https://login.microsoftonline.com/${process.env.TENANT_ID}`,
  }})
  return _msal
}
async function getGraphToken() {
  const r = await getMsal().acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] })
  if (!r?.accessToken) throw new Error('No graph token')
  return r.accessToken
}

// ── Whitelist — NEVER unsubscribe from these domains ──────────────────────────
const WHITELIST_DOMAINS = [
  'loweshomeservices.com', 'trustedhomeservices.com', 'homedepot.com',
  'theispc.com', 'foundationfinance.com', 'synchronybusiness.com', 'aquafinance.com',
  'fastfieldforms.com', 'fastfield.com',
  'salesforce.com', 'rainsoftse.com', 'rainsoft.com',
  'microsoft.com', 'google.com', 'apple.com',
  'twilio.com', 'elevenlabs.io', 'render.com', 'railway.app',
  'smartmailgroup.com', 'ken@rainsoftse.com',
]

function isWhitelisted(fromAddress) {
  if (!fromAddress) return false
  const lower = fromAddress.toLowerCase()
  return WHITELIST_DOMAINS.some(d => lower.includes(d))
}

// ── Extract unsubscribe URL from email headers/body ───────────────────────────
function extractUnsubscribeUrl(headers, bodyHtml, bodyText) {
  // 1. Check List-Unsubscribe header (most reliable)
  const listUnsub = headers?.find(h => h.name?.toLowerCase() === 'list-unsubscribe')
  if (listUnsub?.value) {
    // Format: <https://...> or <mailto:...>
    const urlMatch = listUnsub.value.match(/<(https?:\/\/[^>]+)>/)
    if (urlMatch) return { url: urlMatch[1], method: 'header' }
    const mailtoMatch = listUnsub.value.match(/<(mailto:[^>]+)>/)
    if (mailtoMatch) return { url: mailtoMatch[1], method: 'mailto' }
  }

  // 2. Check List-Unsubscribe-Post header (one-click unsubscribe RFC 8058)
  const listUnsubPost = headers?.find(h => h.name?.toLowerCase() === 'list-unsubscribe-post')
  if (listUnsubPost?.value && listUnsub) {
    const urlMatch2 = listUnsub?.value?.match(/<(https?:\/\/[^>]+)>/)
    if (urlMatch2) return { url: urlMatch2[1], method: 'post', postBody: listUnsubPost.value }
  }

  // 3. Scan body for unsubscribe links
  const body = bodyHtml || bodyText || ''
  const patterns = [
    /href=["'](https?:\/\/[^"']*unsubscribe[^"']*)/i,
    /href=["'](https?:\/\/[^"']*optout[^"']*)/i,
    /href=["'](https?:\/\/[^"']*opt-out[^"']*)/i,
    /href=["'](https?:\/\/[^"']*remove[^"']*email[^"']*)/i,
  ]
  for (const pattern of patterns) {
    const m = body.match(pattern)
    if (m) return { url: m[1], method: 'body_link' }
  }

  return null
}

// ── Fire the unsubscribe ──────────────────────────────────────────────────────
async function fireUnsubscribe(unsubInfo) {
  const { url, method, postBody } = unsubInfo

  if (method === 'mailto') {
    // mailto: unsubscribe — can't easily fire without SMTP, log as manual
    return { success: false, note: 'mailto: unsubscribe requires manual action' }
  }

  try {
    const parsed = new URL(url)
    const isHttps = parsed.protocol === 'https:'
    const mod = isHttps ? https : http

    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: method === 'post' ? 'POST' : 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*',
      },
      timeout: 10000,
    }

    const body = method === 'post' ? (postBody || 'List-Unsubscribe=One-Click') : null
    if (body) {
      options.headers['Content-Type'] = 'application/x-www-form-urlencoded'
      options.headers['Content-Length'] = Buffer.byteLength(body)
    }

    return await new Promise((resolve) => {
      const req = mod.request(options, (res) => {
        resolve({ success: res.statusCode < 400, statusCode: res.statusCode })
      })
      req.on('error', (e) => resolve({ success: false, error: e.message }))
      req.setTimeout(10000, () => { req.destroy(); resolve({ success: false, error: 'timeout' }) })
      if (body) req.write(body)
      req.end()
    })
  } catch (err) {
    return { success: false, error: err.message }
  }
}

// ── M365 scan ─────────────────────────────────────────────────────────────────
async function scanM365(sb, dryRun = false) {
  const token = await getGraphToken()
  const mailbox = process.env.MAILBOX_EMAIL || 'rebecca@rainsoftse.com'
  const results = []

  // Fetch recent emails — last 100
  const r = await fetch(
    `https://graph.microsoft.com/v1.0/users/${mailbox}/messages?$top=100&$select=id,subject,from,receivedDateTime,internetMessageHeaders,body&$orderby=receivedDateTime desc`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!r.ok) throw new Error(`Graph ${r.status}`)
  const data = await r.json()
  const emails = data.value || []

  for (const email of emails) {
    const from = email.from?.emailAddress?.address || ''
    if (isWhitelisted(from)) continue

    // Check if already processed
    const { data: existing } = await sb.from('unsubscribe_log')
      .select('id').eq('email_id', email.id).maybeSingle()
    if (existing) continue

    const headers = email.internetMessageHeaders || []
    const bodyHtml = email.body?.content || ''
    const unsub = extractUnsubscribeUrl(headers, bodyHtml, '')

    if (!unsub) continue

    const logEntry = {
      email_id: email.id,
      inbox: mailbox,
      from_address: from,
      subject: email.subject?.slice(0, 200),
      received_at: email.receivedDateTime,
      unsub_url: unsub.url,
      unsub_method: unsub.method,
      status: 'pending',
      fired_at: null,
      result: null,
    }

    if (!dryRun) {
      const result = await fireUnsubscribe(unsub)
      logEntry.status = result.success ? 'unsubscribed' : 'failed'
      logEntry.fired_at = new Date().toISOString()
      logEntry.result = JSON.stringify(result)

      // Delete the email from inbox after unsubscribing
      if (result.success) {
        await fetch(`https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${email.id}`,
          { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } })
          .catch(() => {}) // non-critical
      }
    }

    await sb.from('unsubscribe_log').upsert(logEntry, { onConflict: 'email_id' })
    results.push(logEntry)
  }

  return results
}

// ── Gmail scan ────────────────────────────────────────────────────────────────
async function scanGmail(sb, dryRun = false) {
  const gmailToken = process.env.GMAIL_ACCESS_TOKEN
  if (!gmailToken) return { error: 'Gmail not connected — needs OAuth setup', results: [] }

  const results = []

  // List recent messages
  const listR = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=100&q=in:inbox',
    { headers: { Authorization: `Bearer ${gmailToken}` } }
  )
  if (!listR.ok) {
    const err = await listR.text()
    if (listR.status === 401) return { error: 'Gmail token expired — needs re-auth', results: [] }
    return { error: `Gmail list ${listR.status}: ${err.slice(0,100)}`, results: [] }
  }

  const listData = await listR.json()
  const messages = listData.messages || []

  for (const msg of messages.slice(0, 50)) {
    // Check cache first
    const { data: existing } = await sb.from('unsubscribe_log')
      .select('id').eq('email_id', msg.id).maybeSingle()
    if (existing) continue

    // Fetch full message
    const msgR = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}?format=full`,
      { headers: { Authorization: `Bearer ${gmailToken}` } }
    )
    if (!msgR.ok) continue
    const msgData = await msgR.json()

    const headers = msgData.payload?.headers || []
    const getHeader = (name) => headers.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || ''
    const from = getHeader('from')
    const fromEmail = from.match(/<([^>]+)>/)?.[1] || from

    if (isWhitelisted(fromEmail)) continue

    // Get body
    let bodyHtml = ''
    const parts = msgData.payload?.parts || [msgData.payload]
    for (const part of parts) {
      if (part?.mimeType === 'text/html' && part?.body?.data) {
        bodyHtml = Buffer.from(part.body.data, 'base64').toString('utf8')
        break
      }
    }

    const headerList = headers.map(h => ({ name: h.name, value: h.value }))
    const unsub = extractUnsubscribeUrl(headerList, bodyHtml, '')
    if (!unsub) continue

    const logEntry = {
      email_id: msg.id,
      inbox: 'rbccann6@gmail.com',
      from_address: fromEmail,
      subject: getHeader('subject')?.slice(0, 200),
      received_at: new Date(parseInt(msgData.internalDate)).toISOString(),
      unsub_url: unsub.url,
      unsub_method: unsub.method,
      status: 'pending',
      fired_at: null,
      result: null,
    }

    if (!dryRun) {
      const result = await fireUnsubscribe(unsub)
      logEntry.status = result.success ? 'unsubscribed' : 'failed'
      logEntry.fired_at = new Date().toISOString()
      logEntry.result = JSON.stringify(result)

      // Trash the email after unsubscribing
      if (result.success) {
        await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${msg.id}/trash`,
          { method: 'POST', headers: { Authorization: `Bearer ${gmailToken}` } })
          .catch(() => {})
      }
    }

    await sb.from('unsubscribe_log').upsert(logEntry, { onConflict: 'email_id' })
    results.push(logEntry)
  }

  return { results }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/unsubscribe/run — run the agent now
router.post('/unsubscribe/run', async (req, res) => {
  const dryRun = req.query.dry === 'true'
  const sb = getSB()
  try {
    const [m365Results, gmailData] = await Promise.allSettled([
      scanM365(sb, dryRun),
      scanGmail(sb, dryRun),
    ])

    const m365 = m365Results.status === 'fulfilled' ? m365Results.value : []
    const m365Error = m365Results.status === 'rejected' ? m365Results.reason?.message : null
    const gmail = gmailData.status === 'fulfilled' ? gmailData.value : {}
    const gmailError = gmailData.status === 'rejected' ? gmailData.reason?.message : null

    const allResults = [...(Array.isArray(m365) ? m365 : []), ...(gmail.results || [])]
    const unsubscribed = allResults.filter(r => r.status === 'unsubscribed').length
    const failed = allResults.filter(r => r.status === 'failed').length
    const pending = allResults.filter(r => r.status === 'pending').length

    res.json({
      ok: true,
      dryRun,
      summary: { total: allResults.length, unsubscribed, failed, pending },
      m365: { count: Array.isArray(m365) ? m365.length : 0, error: m365Error },
      gmail: { count: gmail.results?.length || 0, error: gmail.error || gmailError },
      results: allResults,
    })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// GET /api/unsubscribe/log — view recent unsubscribe activity
router.get('/unsubscribe/log', async (req, res) => {
  try {
    const sb = getSB()
    const { data, error } = await sb
      .from('unsubscribe_log')
      .select('*')
      .order('fired_at', { ascending: false, nullsFirst: false })
      .limit(200)
    if (error) throw error
    res.json({ ok: true, log: data || [] })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

// GET /api/unsubscribe/gmail-auth — get Gmail OAuth URL
router.get('/unsubscribe/gmail-auth', (req, res) => {
  const clientId = process.env.GMAIL_CLIENT_ID
  const redirectUri = process.env.GMAIL_REDIRECT_URI || `${process.env.APP_URL || 'https://rainsoft-ops-dashboard.onrender.com'}/api/unsubscribe/gmail-callback`
  const scope = 'https://www.googleapis.com/auth/gmail.modify'
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${encodeURIComponent(scope)}&access_type=offline&prompt=consent`
  res.json({ authUrl: url })
})

// GET /api/unsubscribe/gmail-callback — exchange code for token
router.get('/unsubscribe/gmail-callback', async (req, res) => {
  const { code } = req.query
  if (!code) return res.status(400).send('No code')

  const clientId = process.env.GMAIL_CLIENT_ID
  const clientSecret = process.env.GMAIL_CLIENT_SECRET
  const redirectUri = process.env.GMAIL_REDIRECT_URI || `${process.env.APP_URL || 'https://rainsoft-ops-dashboard.onrender.com'}/api/unsubscribe/gmail-callback`

  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' })
  })
  const tokens = await r.json()

  if (tokens.access_token) {
    // Save to Supabase for persistence
    const sb = getSB()
    await sb.from('app_config').upsert({ key: 'gmail_tokens', value: JSON.stringify(tokens) }, { onConflict: 'key' })
    res.send('<h2>✅ Gmail connected! You can close this tab.</h2><p>The unsubscribe agent will now scan rbccann6@gmail.com automatically.</p>')
  } else {
    res.status(400).send(`<h2>❌ Auth failed</h2><pre>${JSON.stringify(tokens)}</pre>`)
  }
})

export default router
