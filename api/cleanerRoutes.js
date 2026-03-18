/**
 * Email Cleaner Routes
 * Server-side bulk sender analysis + delete across all 60k emails.
 * Never touches emails from safe/business senders.
 */

import express from 'express'
import { ConfidentialClientApplication } from '@azure/msal-node'

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
  'salesforce.com', 'salesforceiq.com', 'force.com', 'exacttarget.com',
  'docusign.net', 'docusign.com', 'fastfieldforms.com',
  'rippling.com', 'loweshomeservices.com', 'imeinc.com', 'trustedhomeservices.com',
  'homedepot.com', 'smartmailgroup.com', 'microsoft.com', 'microsoftonline.com',
  'aflac.com', 'accounts.google.com', 'wellsfargo.com', 'americanexpress.com',
  'welcome.americanexpress.com', 'squareup.com', 'legal.squareup.com',
  'notify.wellsfargo.com', 'accountprotection.microsoft.com',
])

function getDomain(email) {
  return email?.split('@')[1]?.toLowerCase() ?? ''
}

function isSafe(senderEmail) {
  const domain = getDomain(senderEmail)
  if (SAFE_DOMAINS.has(domain)) return true
  // Protect subdomains — e.g. mail.rainsoftse.com is still rainsoftse.com
  for (const safeDomain of SAFE_DOMAINS) {
    if (domain.endsWith('.' + safeDomain)) return true
  }
  return false
}

// ─── Supabase-backed persistence (survives Render restarts) ─────────────────
import { createClient } from '@supabase/supabase-js'

function getSB() {
  return createClient(
    process.env.SUPABASE_URL || 'https://njqavagyuwdmkeyoscbz.supabase.co',
    process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5qcWF2YWd5dXdkbWtleW9zY2J6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Mzc1NTM4MywiZXhwIjoyMDg5MzMxMzgzfQ.67pxlJAlqIKgTgDwpoDBcQZ12ezT3ZPbQRXsBnRptPs'
  )
}

function loadScanCache() { return null }  // stub — Supabase loaded async on status poll

async function saveScanCache(state) {
  // Save sender list to Supabase for persistence across restarts
  try {
    const sb = getSB()
    // Upsert each sender
    for (const sender of (state.senders || [])) {
      await sb.from('sender_scan_cache').upsert({
        sender_email: sender.email,
        sender_name: sender.name,
        domain: sender.domain,
        email_count: sender.count,
        is_safe: sender.safe,
        samples: sender.samples,
        scanned_at: new Date().toISOString(),
      }, { onConflict: 'sender_email' })
    }
  } catch (err) {
    console.warn('saveScanCache error:', err.message)
  }
}

async function loadScanCacheFromDB() {
  try {
    const sb = getSB()
    const { data } = await sb.from('sender_scan_cache').select('*').order('email_count', { ascending: false })
    if (!data || data.length === 0) return null
    return {
      status: 'done',
      startedAt: data[0]?.scanned_at || null,
      finishedAt: data[0]?.scanned_at || null,
      pagesScanned: 0,
      totalScanned: data.reduce((s, r) => s + (r.email_count || 0), 0),
      error: null,
      senders: data.map(r => ({
        name: r.sender_name, email: r.sender_email, domain: r.domain,
        count: r.email_count, safe: r.is_safe, samples: r.samples || [],
      }))
    }
  } catch { return null }
}

async function isDeleted(senderEmail) {
  try {
    const { data } = await getSB().from('deleted_senders').select('id').eq('sender_email', senderEmail.toLowerCase()).single()
    return !!data
  } catch { return false }
}

async function markDeleted(senderEmail, count) {
  try {
    await getSB().from('deleted_senders').upsert({
      sender_email: senderEmail.toLowerCase(), deleted_count: count, deleted_at: new Date().toISOString()
    }, { onConflict: 'sender_email' })
  } catch {}
}

// ─── Background scan state (in-memory, survives the request lifecycle) ────────

const cached = loadScanCache()
let scanState = cached ?? {
  status: 'idle', // idle | running | done | error
  startedAt: null,
  finishedAt: null,
  pagesScanned: 0,
  totalScanned: 0,
  senders: [],
  error: null,
}

async function runFullScan() {
  if (scanState.status === 'running') return // already running

  scanState = { status: 'running', startedAt: new Date().toISOString(), finishedAt: null, pagesScanned: 0, totalScanned: 0, senders: [], error: null }

  try {
    const token = await withRetry(getToken, 'token')
    const mailbox = process.env.MAILBOX_EMAIL
    const senderMap = {}

    let url = `https://graph.microsoft.com/v1.0/users/${mailbox}/messages?` +
      `$top=999&$select=id,from,subject,receivedDateTime&$orderby=receivedDateTime desc`

    let pageCount = 0
    const MAX_PAGES = 200

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
          senderMap[addr] = { name, email: addr, domain, count: 0, safe: isSafe(addr), samples: [] }
        }
        senderMap[addr].count++
        if (senderMap[addr].samples.length < 3) {
          senderMap[addr].samples.push({ subject: msg.subject, date: msg.receivedDateTime })
        }
      }

      scanState.pagesScanned = ++pageCount
      scanState.totalScanned = Object.values(senderMap).reduce((s, x) => s + x.count, 0)
      // Update senders progressively so poll endpoint shows progress
      scanState.senders = Object.values(senderMap).sort((a, b) => b.count - a.count)

      url = data['@odata.nextLink'] ?? null
      // Small pause to avoid throttling
      if (url) await new Promise(r => setTimeout(r, 200))
    }

    scanState.status = 'done'
    scanState.finishedAt = new Date().toISOString()
    // Persist to disk — won't rescan on next page load
    saveScanCache(scanState)
  } catch (err) {
    scanState.status = 'error'
    scanState.error = err.message
    console.error('Background scan failed:', err.message)
  }
}

// ─── POST /api/cleaner/scan/start — kick off background scan ─────────────────
// Pass { force: true } to rescan even if results already cached.

router.post('/cleaner/scan/start', (req, res) => {
  const force = req.body?.force === true

  if (scanState.status === 'done' && !force) {
    // Already have results — don't rescan
    return res.json({ started: false, status: 'done', message: 'Using cached results. Pass force:true to rescan.' })
  }

  if (scanState.status !== 'running') {
    if (force) {
      // Reset state for fresh scan
      scanState = { status: 'idle', startedAt: null, finishedAt: null, pagesScanned: 0, totalScanned: 0, senders: [], error: null }
    }
    runFullScan()
  }

  res.json({ started: true, status: scanState.status })
})

// ─── GET /api/cleaner/scan/status — poll progress ────────────────────────────

router.get('/cleaner/scan/status', async (req, res) => {
  // If server just restarted and has no scan data, try loading from Supabase
  if (scanState.status === 'idle') {
    const dbCache = await loadScanCacheFromDB()
    if (dbCache) {
      scanState = dbCache
      console.log('[cleaner] Restored scan cache from Supabase:', dbCache.senders.length, 'senders')
    }
  }
  res.json({
    status: scanState.status,
    pagesScanned: scanState.pagesScanned,
    totalScanned: scanState.totalScanned,
    totalSenders: scanState.senders.length,
    startedAt: scanState.startedAt,
    finishedAt: scanState.finishedAt,
    error: scanState.error,
    senders: scanState.status === 'done' ? scanState.senders : [],
  })
})

// ─── POST /api/cleaner/delete-sender — delete all emails from a sender ────────

router.post('/cleaner/delete-sender', async (req, res) => {
  const { senderEmail } = req.body
  if (!senderEmail) return res.status(400).json({ error: 'senderEmail required' })
  if (isSafe(senderEmail)) return res.status(403).json({ error: 'Refusing to delete emails from safe sender' })
  // Check Supabase safelist (kept senders)
  try {
    const { data } = await getSB().from('email_safelist').select('id').eq('email', senderEmail.toLowerCase()).maybeSingle()
    if (data) return res.status(403).json({ error: 'Sender is in your Keep list' })
    // Also check domain
    const domain = senderEmail.split('@')[1]?.toLowerCase()
    if (domain) {
      const { data: domData } = await getSB().from('email_safelist').select('id').eq('domain', domain).maybeSingle()
      if (domData) return res.status(403).json({ error: 'Sender domain is in your Keep list' })
    }
  } catch {}

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

    // Persist deletion record so it doesn't reappear after restart
    if (deleted > 0) {
      await markDeleted(senderEmail, deleted)
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
