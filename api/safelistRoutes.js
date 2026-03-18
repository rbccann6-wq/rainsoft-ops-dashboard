/**
 * Safelist Routes — Supabase-backed (survives Render restarts)
 * Persists user-approved senders so they never get flagged as spam again.
 */

import express from 'express'
import { createClient } from '@supabase/supabase-js'
import { ConfidentialClientApplication } from '@azure/msal-node'

const router = express.Router()

function getSB() {
  return createClient(
    process.env.SUPABASE_URL || 'https://njqavagyuwdmkeyoscbz.supabase.co',
    process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5qcWF2YWd5dXdkbWtleW9zY2J6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Mzc1NTM4MywiZXhwIjoyMDg5MzMxMzgzfQ.67pxlJAlqIKgTgDwpoDBcQZ12ezT3ZPbQRXsBnRptPs'
  )
}

let _msal = null
function getMsal() {
  if (!_msal) _msal = new ConfidentialClientApplication({ auth: {
    clientId: process.env.CLIENT_ID, clientSecret: process.env.CLIENT_SECRET,
    authority: `https://login.microsoftonline.com/${process.env.TENANT_ID}`,
  }})
  return _msal
}

async function getToken() {
  const r = await getMsal().acquireTokenByClientCredential({ scopes: ['https://graph.microsoft.com/.default'] })
  if (!r?.accessToken) throw new Error('No token')
  return r.accessToken
}

async function withRetry(fn, max = 3) {
  let err
  for (let i = 1; i <= max; i++) {
    try { return await fn() } catch (e) { err = e; if (i < max) await new Promise(r => setTimeout(r, 1000 * i)) }
  }
  throw err
}

// ── Safelist helpers ──────────────────────────────────────────────────────────

async function getSafelist() {
  try {
    const { data } = await getSB().from('email_safelist').select('email, domain')
    const emails = (data || []).map(r => r.email).filter(Boolean)
    const domains = (data || []).map(r => r.domain).filter(Boolean)
    return { emails, domains }
  } catch { return { emails: [], domains: [] } }
}

async function addToSafelist(email, domain) {
  const sb = getSB()
  if (email) {
    const e = email.toLowerCase().trim()
    await sb.from('email_safelist').upsert({ email: e }, { onConflict: 'email' })
    // Auto-safelist domain if 3+ emails from same domain
    const dom = e.split('@')[1]
    if (dom) {
      const { data } = await sb.from('email_safelist').select('email').ilike('email', `%@${dom}`)
      if (data && data.length >= 3) {
        await sb.from('email_safelist').upsert({ domain: dom }, { onConflict: 'email' })
      }
    }
  }
  if (domain) {
    await sb.from('email_safelist').upsert({ domain: domain.toLowerCase().trim() }, { onConflict: 'email' })
  }
}

async function removeFromSafelist(email) {
  await getSB().from('email_safelist').delete().eq('email', email.toLowerCase().trim())
}

// ── GET /api/safelist ─────────────────────────────────────────────────────────

router.get('/safelist', async (req, res) => {
  res.json(await getSafelist())
})

// ── POST /api/safelist/add ────────────────────────────────────────────────────

router.post('/safelist/add', async (req, res) => {
  const { senderEmail, messageId } = req.body
  if (!senderEmail) return res.status(400).json({ error: 'senderEmail required' })

  const results = { safelisted: false, m365SafeSender: false, movedToInbox: false, errors: [] }

  // 1. Add to Supabase safelist
  try {
    await addToSafelist(senderEmail)
    results.safelisted = true
  } catch (err) {
    results.errors.push(`Safelist: ${err.message}`)
  }

  // 2. Move message to inbox if messageId provided
  if (messageId) {
    try {
      const token = await withRetry(getToken)
      const mailbox = process.env.MAILBOX_EMAIL
      const r = await fetch(`https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${messageId}/move`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ destinationId: 'inbox' }),
      })
      if (r.ok) results.movedToInbox = true
      else results.errors.push(`Move: HTTP ${r.status}`)
    } catch (err) {
      results.errors.push(`Move: ${err.message}`)
    }
  }

  // 3. M365 inference classification override
  try {
    const token = await withRetry(getToken)
    const mailbox = process.env.MAILBOX_EMAIL
    const r = await fetch(`https://graph.microsoft.com/v1.0/users/${mailbox}/inferenceClassification/overrides`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ classifyAs: 'focused', senderEmailAddress: { address: senderEmail.toLowerCase() } }),
    })
    if (r.ok || r.status === 409) results.m365SafeSender = true
    else results.errors.push(`M365 override: HTTP ${r.status}`)
  } catch (err) {
    results.errors.push(`M365 override: ${err.message}`)
  }

  res.json(results)
})

// ── DELETE /api/safelist/remove ───────────────────────────────────────────────

router.delete('/safelist/remove', async (req, res) => {
  const { senderEmail } = req.body
  if (!senderEmail) return res.status(400).json({ error: 'senderEmail required' })
  try {
    await removeFromSafelist(senderEmail)
    // Also remove M365 override
    try {
      const token = await withRetry(getToken)
      const mailbox = process.env.MAILBOX_EMAIL
      const listResp = await fetch(`https://graph.microsoft.com/v1.0/users/${mailbox}/inferenceClassification/overrides`, {
        headers: { Authorization: `Bearer ${token}` }
      })
      if (listResp.ok) {
        const overrides = await listResp.json()
        const match = (overrides.value || []).find(o => o.senderEmailAddress?.address?.toLowerCase() === senderEmail.toLowerCase())
        if (match) {
          await fetch(`https://graph.microsoft.com/v1.0/users/${mailbox}/inferenceClassification/overrides/${match.id}`, {
            method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
          })
        }
      }
    } catch {}
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router

// Export for use in cleanerRoutes
export { getSafelist, addToSafelist }
