/**
 * Bills & Subscriptions Routes
 * Scans M365 inbox for invoices, statements, payments, and recurring charges.
 * Classifies by category, extracts amounts, detects recurring patterns.
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

async function getGraphToken() {
  const result = await getMsalClient().acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  })
  if (!result?.accessToken) throw new Error('Failed to acquire Graph token')
  return result.accessToken
}

async function withRetry(fn, label, maxAttempts = 3) {
  let lastErr
  for (let i = 1; i <= maxAttempts; i++) {
    try { return await fn() } catch (err) {
      lastErr = err
      if (i < maxAttempts) await new Promise(r => setTimeout(r, 1000 * i))
    }
  }
  throw new Error(`[${label}] failed after ${maxAttempts} attempts: ${lastErr.message}`)
}

// ─── Classification rules ─────────────────────────────────────────────────────

const BILL_SENDERS = [
  // Business
  { domain: 'pentair.com', vendor: 'Pentair', category: 'Business', type: 'invoice' },
  { domain: 'dialpad.com', vendor: 'Dialpad', category: 'Business', type: 'subscription' },
  { domain: 'rippling.com', vendor: 'Rippling', category: 'Business', type: 'subscription' },
  { domain: 'salesforce.com', vendor: 'Salesforce', category: 'Business', type: 'subscription' },
  { domain: 'fastfieldforms.com', vendor: 'FastField Forms', category: 'Business', type: 'subscription' },
  { domain: 'loweshomeservices.com', vendor: "Lowe's Home Services", category: 'Business', type: 'invoice' },
  { domain: 'homedepot.com', vendor: 'Home Depot', category: 'Business', type: 'invoice' },
  // Insurance / Financial
  { domain: 'aflac.com', vendor: 'Aflac', category: 'Insurance', type: 'subscription' },
  { domain: 'family.gerberlife.com', vendor: 'Gerber Life', category: 'Insurance', type: 'subscription' },
  { domain: 'welcome.americanexpress.com', vendor: 'American Express', category: 'Personal', type: 'statement' },
  { domain: 'member.americanexpress.com', vendor: 'American Express', category: 'Personal', type: 'statement' },
  { domain: 'americanexpress.com', vendor: 'American Express', category: 'Personal', type: 'statement' },
  { domain: 'notify.wellsfargo.com', vendor: 'Wells Fargo', category: 'Personal', type: 'statement' },
  // Personal subscriptions
  { domain: 'mc.siriusxm.com', vendor: 'SiriusXM', category: 'Personal', type: 'subscription' },
  { domain: 'docusign.net', vendor: 'DocuSign', category: 'Business', type: 'invoice' },
]

const BILL_SUBJECT_PATTERNS = [
  /invoice/i, /statement/i, /payment/i, /receipt/i,
  /\byour bill\b/i, /amount due/i, /auto.?pay/i, /renewal/i,
  /subscription/i, /\bdue\b/i, /order confirmation/i,
]

function extractAmount(text) {
  // Match dollar amounts like $1,234.56 or $45
  const matches = text.match(/\$[\d,]+\.?\d*/g) || []
  // Filter out clearly wrong ones (like $1 from promo texts)
  const valid = matches
    .map(m => parseFloat(m.replace(/[$,]/g, '')))
    .filter(n => n >= 1 && n < 100000)
    .sort((a, b) => b - a) // largest first — usually the total
  return valid.length > 0 ? valid[0] : null
}

function getDomain(email) {
  return email?.split('@')[1]?.toLowerCase() ?? ''
}

function classifyMessage(msg) {
  const senderEmail = msg.from?.emailAddress?.address ?? ''
  const domain = getDomain(senderEmail)
  const subject = msg.subject ?? ''
  const preview = msg.bodyPreview ?? ''

  // Match known sender
  const knownSender = BILL_SENDERS.find(s =>
    domain === s.domain || domain.endsWith('.' + s.domain)
  )

  // Match subject patterns
  const subjectMatch = BILL_SUBJECT_PATTERNS.some(p => p.test(subject))

  if (!knownSender && !subjectMatch) return null

  const amount = extractAmount(subject + ' ' + preview)
  const vendor = knownSender?.vendor ?? msg.from?.emailAddress?.name ?? senderEmail
  const category = knownSender?.category ?? 'Other'
  const type = knownSender?.type ?? 'invoice'

  return {
    id: msg.id,
    vendor,
    senderEmail,
    subject,
    amount,
    category,
    type,
    date: msg.receivedDateTime,
    preview,
  }
}

// ─── Detect recurring patterns ────────────────────────────────────────────────

function detectRecurring(bills) {
  const byVendor = {}
  for (const b of bills) {
    if (!byVendor[b.vendor]) byVendor[b.vendor] = []
    byVendor[b.vendor].push(b)
  }

  return bills.map(bill => {
    const vendorBills = byVendor[bill.vendor] || []
    return {
      ...bill,
      isRecurring: vendorBills.length > 1,
      occurrences: vendorBills.length,
    }
  })
}

// ─── GET /api/bills ───────────────────────────────────────────────────────────

router.get('/bills', async (req, res) => {
  try {
    const token = await withRetry(getGraphToken, 'graph-token')
    const mailbox = process.env.MAILBOX_EMAIL

    // Fetch last 90 days of email, larger window to catch monthly recurrings
    const since = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
    const qs = new URLSearchParams({
      $filter: `receivedDateTime ge ${since}`,
      $top: '200',
      $orderby: 'receivedDateTime desc',
      $select: 'id,subject,from,receivedDateTime,bodyPreview,isRead',
    })

    const data = await withRetry(async () => {
      const r = await fetch(
        `https://graph.microsoft.com/v1.0/users/${mailbox}/messages?${qs}`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (!r.ok) throw new Error(`Graph ${r.status}`)
      return r.json()
    }, 'graph-fetch-bills')

    const rawBills = (data.value || [])
      .map(classifyMessage)
      .filter(Boolean)

    const bills = detectRecurring(rawBills)

    // Summary stats
    const totalMonthly = bills
      .filter(b => b.isRecurring && b.amount)
      .reduce((sum, b) => {
        // Rough monthly estimate: if more than 2 occurrences in 90 days, ~monthly
        return sum + (b.amount || 0)
      }, 0)

    res.json({
      bills,
      summary: {
        total: bills.length,
        recurring: bills.filter(b => b.isRecurring).length,
        estimatedMonthlySpend: Math.round(totalMonthly * 100) / 100,
        byCategory: {
          Business: bills.filter(b => b.category === 'Business').length,
          Personal: bills.filter(b => b.category === 'Personal').length,
          Insurance: bills.filter(b => b.category === 'Insurance').length,
          Other: bills.filter(b => b.category === 'Other').length,
        },
      },
    })
  } catch (err) {
    console.error('GET /api/bills:', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router
