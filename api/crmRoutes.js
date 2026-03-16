/**
 * CRM Export Routes
 *
 * Currently stubs that log + return success.
 * When Salesforce credentials are ready, replace the stub body in
 * pushToSalesforce() with real API calls — the route interface stays identical.
 */

import express from 'express'

const router = express.Router()

// ─── Retry helper ─────────────────────────────────────────────────────────────

async function withRetry(fn, label, maxAttempts = 3) {
  let lastErr
  for (let i = 1; i <= maxAttempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      console.warn(`[${label}] attempt ${i}/${maxAttempts} failed:`, err.message)
      if (i < maxAttempts) await new Promise(r => setTimeout(r, 1000 * i))
    }
  }
  throw new Error(`[${label}] failed after ${maxAttempts} attempts: ${lastErr.message}`)
}

// ─── CRM push (stub — ready for Salesforce) ───────────────────────────────────

async function pushToSalesforce(lead) {
  // TODO: Replace this stub with real Salesforce REST API call
  // e.g. POST /services/data/v57.0/sobjects/Lead/
  // Credentials: process.env.SF_INSTANCE_URL, process.env.SF_ACCESS_TOKEN

  if (!process.env.SF_INSTANCE_URL) {
    // Stub mode — log and succeed
    console.log('[CRM-stub] Would push lead to Salesforce:', {
      FirstName: lead.customerName?.split(' ')[0],
      LastName: lead.customerName?.split(' ').slice(1).join(' '),
      Phone: lead.phone,
      Email: lead.email,
      Street: lead.address,
      LeadSource: `Lowes - ${lead.store}`,
      Description: `WO #${lead.woId} | Status: ${lead.status}`,
      Company: 'RainSoft Lead',
    })
    return { id: `stub-${lead.woId}`, success: true, stub: true }
  }

  // Real Salesforce call (active when SF_INSTANCE_URL + SF_ACCESS_TOKEN are set)
  const body = JSON.stringify({
    FirstName: lead.customerName?.split(' ')[0] ?? '',
    LastName: lead.customerName?.split(' ').slice(1).join(' ') || 'Unknown',
    Phone: lead.phone,
    MobilePhone: lead.officePhone,
    Email: lead.email,
    Street: lead.address,
    LeadSource: `Lowe's`,
    Description: `WO #${lead.woId} | Store: ${lead.store} | Status: ${lead.status}`,
    Company: 'RainSoft Lead',
  })

  const resp = await fetch(
    `${process.env.SF_INSTANCE_URL}/services/data/v57.0/sobjects/Lead/`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.SF_ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body,
    }
  )

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Salesforce ${resp.status}: ${text}`)
  }

  return resp.json()
}

// ─── POST /api/crm/export-lead ────────────────────────────────────────────────

router.post('/crm/export-lead', async (req, res) => {
  const lead = req.body
  if (!lead?.woId) return res.status(400).json({ error: 'lead.woId is required' })

  try {
    const result = await withRetry(() => pushToSalesforce(lead), `crm-export-${lead.woId}`)
    res.json({ success: true, crmId: result.id, stub: result.stub ?? false })
  } catch (err) {
    console.error('POST /api/crm/export-lead:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── POST /api/crm/export-all ─────────────────────────────────────────────────

router.post('/crm/export-all', async (req, res) => {
  const { leads } = req.body
  if (!Array.isArray(leads)) return res.status(400).json({ error: 'leads array required' })

  let exported = 0
  let errors = 0

  // Serialize — don't blast Salesforce with parallel requests
  for (const lead of leads) {
    try {
      await withRetry(() => pushToSalesforce(lead), `crm-bulk-${lead.woId}`)
      exported++
    } catch (err) {
      console.error(`[crm-bulk] failed for WO ${lead.woId}:`, err.message)
      errors++
    }
  }

  res.json({ exported, errors })
})

export default router
