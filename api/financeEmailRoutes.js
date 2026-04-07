/**
 * Finance Email Watcher
 * Scans inbox for emails from finance companies, extracts PDFs, attaches to Salesforce leads
 */

import express from 'express'
import { ConfidentialClientApplication } from '@azure/msal-node'
import { createClient } from '@supabase/supabase-js'

const router = express.Router()

const FINANCE_DOMAINS = ['theispc.com', 'foundationfinance.com', 'synchronybusiness.com', 'aquafinance.com', 'fastfieldforms.com', 'fastfield.com']
const SF_INSTANCE = 'https://rainsoftse.my.salesforce.com'

function getSB() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY)
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

let _sfToken = null, _sfExpiry = 0
async function getSfToken() {
  if (_sfToken && Date.now() < _sfExpiry) return _sfToken
  const username = process.env.SF_USERNAME
  const password = process.env.SF_PASSWORD
  if (!username || !password) throw new Error('SF_USERNAME and SF_PASSWORD env vars required')
  const soap = `<?xml version="1.0" encoding="utf-8"?><env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><n1:login xmlns:n1="urn:partner.soap.sforce.com"><n1:username>${username}</n1:username><n1:password>${password}</n1:password></n1:login></env:Body></env:Envelope>`
  const r = await fetch('https://login.salesforce.com/services/Soap/u/59.0', { method: 'POST', headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: 'login' }, body: soap })
  const text = await r.text()
  const m = text.match(/<sessionId>([^<]+)<\/sessionId>/)
  if (!m) throw new Error('SF login failed')
  _sfToken = m[1]; _sfExpiry = Date.now() + 55 * 60 * 1000
  return _sfToken
}

async function sfQuery(soql) {
  const token = await getSfToken()
  const r = await fetch(`${SF_INSTANCE}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!r.ok) throw new Error(`SF query ${r.status}`)
  return r.json()
}

/** Detect if email indicates an approval/funding decision */
function detectApproval(subject, bodyPreview) {
  const text = `${subject} ${bodyPreview}`.toLowerCase()
  const approvalKeywords = ['approved', 'approval', 'funded', 'funding', 'congratulations', 'decision: approved', 'credit approved', 'application approved']
  const declineKeywords = ['declined', 'denied', 'not approved', 'unable to approve']
  if (declineKeywords.some(k => text.includes(k))) return 'declined'
  if (approvalKeywords.some(k => text.includes(k))) return 'approved'
  return 'unknown'
}

/** Extract finance amount from subject/body */
function extractAmount(subject, bodyPreview) {
  const text = `${subject} ${bodyPreview}`
  const m = text.match(/\$\s?([\d,]+(?:\.\d{2})?)/);
  return m ? parseFloat(m[1].replace(',', '')) : null
}

/** Extract customer name from email subject/body — looks for common patterns */
function extractCustomerName(subject, bodyPreview) {
  const text = `${subject} ${bodyPreview}`
  // Patterns: "for John Smith", "applicant: John Smith", "Customer: John Smith", "RE: Smith, John"
  const patterns = [
    /(?:for|applicant|customer|re:)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/i,
    /([A-Z][a-z]+,\s+[A-Z][a-z]+)/, // "Smith, John"
    /([A-Z][a-z]+\s+[A-Z][a-z]+)\s+(?:application|approval|decision|credit)/i,
  ]
  for (const p of patterns) {
    const m = text.match(p)
    if (m) {
      // Normalize "Smith, John" → "John Smith"
      const name = m[1].trim()
      if (name.includes(',')) {
        const parts = name.split(',').map(s => s.trim())
        return `${parts[1]} ${parts[0]}`
      }
      return name
    }
  }
  return null
}

/** Find SF Contact (converted customer) by name — also returns AccountId */
async function findSfContact(customerName) {
  if (!customerName) return null
  const parts = customerName.trim().split(' ')
  const firstName = parts[0]
  const lastName = parts.slice(1).join(' ')
  if (!lastName) return null

  try {
    // Search Contact by first + last name
    const result = await sfQuery(
      `SELECT Id, FirstName, LastName, AccountId FROM Contact WHERE FirstName = '${soqlEscape(firstName)}' AND LastName = '${soqlEscape(lastName)}' ORDER BY CreatedDate DESC LIMIT 1`
    )
    if (result.totalSize > 0) return result.records[0]

    // Fallback: search Account by name (person accounts have full name)
    const result2 = await sfQuery(
      `SELECT Id, Name FROM Account WHERE Name LIKE '%${soqlEscape(lastName)}%' ORDER BY CreatedDate DESC LIMIT 1`
    )
    if (result2.totalSize > 0) return { Id: result2.records[0].Id, AccountId: result2.records[0].Id, _type: 'account' }

    return null
  } catch { return null }
}

/** Attach PDF to SF lead as ContentDocument */
async function attachPdfToLead(contactId, filename, pdfBase64) {
  const token = await getSfToken()

  // 1. Create ContentVersion
  const cvBody = {
    Title: filename.replace('.pdf', ''),
    PathOnClient: filename,
    VersionData: pdfBase64,
    FirstPublishLocationId: contactId,
  }
  const cvR = await fetch(`${SF_INSTANCE}/services/data/v59.0/sobjects/ContentVersion`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cvBody)
  })
  const cvResult = await cvR.json()
  if (!cvResult.success) throw new Error(`ContentVersion failed: ${JSON.stringify(cvResult)}`)
  return cvResult.id
}

// ─── GET /api/finance-emails — scan and process finance emails ───────────────

router.get('/finance-emails', async (req, res) => {
  try {
    const token = await getGraphToken()
    const mailbox = process.env.MAILBOX_EMAIL || 'rebecca@rainsoftse.com'
    const sb = getSB()

    const results = []

    for (const domain of FINANCE_DOMAINS) {
      // Search for emails from this finance domain
      const qs = new URLSearchParams({
        '$search': `"${domain}"`,
        '$top': '5',
        '$select': 'id,subject,receivedDateTime,from,bodyPreview,hasAttachments',
        '$orderby': 'receivedDateTime desc'
      })

      const r = await fetch(`https://graph.microsoft.com/v1.0/users/${mailbox}/messages?${qs}`, {
        headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' }
      })
      if (!r.ok) continue
      const data = await r.json()

      const emails = (data.value || []).filter(e => {
        const from = e.from?.emailAddress?.address?.toLowerCase() || ''
        return from.includes(domain)
      })

      for (const email of emails) {
        // Check if already processed
        const { data: existing } = await sb.from('finance_email_log')
          .select('id').eq('email_id', email.id).maybeSingle()
        if (existing) continue

        if (!email.hasAttachments) continue

        // Fetch attachments
        const attR = await fetch(
          `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${email.id}/attachments`,
          { headers: { Authorization: `Bearer ${token}` } }
        )
        if (!attR.ok) continue
        const attData = await attR.json()

        const pdfs = (attData.value || []).filter(a =>
          a.name?.toLowerCase().endsWith('.pdf') ||
          a.contentType?.toLowerCase().includes('pdf')
        )

        if (!pdfs.length) continue

        // Extract customer name
        const customerName = extractCustomerName(email.subject, email.bodyPreview || '')

        // Find SF lead
        const lead = await findSfContact(customerName)

        const emailResult = {
          emailId: email.id,
          subject: email.subject,
          from: email.from?.emailAddress?.address,
          date: email.receivedDateTime,
          customerName,
          contactFound: !!lead,
          contactId: lead?.Id || null,
          pdfsAttached: [],
          errors: []
        }

        // Detect approval status + amount
        const approvalStatus = detectApproval(email.subject, email.bodyPreview || '')
        const amount = extractAmount(email.subject, email.bodyPreview || '')
        emailResult.approvalStatus = approvalStatus
        emailResult.amount = amount

        // Attach each PDF to SF lead + update notes
        if (lead) {
          for (const pdf of pdfs) {
            try {
              await attachPdfToLead(lead.AccountId || lead.Id, pdf.name, pdf.contentBytes)
              emailResult.pdfsAttached.push(pdf.name)
            } catch (err) {
              emailResult.errors.push(`${pdf.name}: ${err.message}`)
            }
          }

          // Update SF lead notes with finance status
          try {
            const sfToken = await getSfToken()
            const noteAppend = [
              `\n--- FINANCE UPDATE ${new Date().toLocaleDateString()} ---`,
              `Company: ${domain.split('.')[0].toUpperCase()}`,
              approvalStatus === 'approved' ? '✓ APPROVED' : approvalStatus === 'declined' ? '✗ DECLINED' : 'Decision pending',
              amount ? `Amount: $${amount.toLocaleString()}` : null,
              emailResult.pdfsAttached.length ? `PDF: ${emailResult.pdfsAttached.join(', ')}` : null,
            ].filter(Boolean).join(' | ')

            // Get current notes
            const targetId = lead.AccountId || lead.Id
            const leadR = await fetch(`${SF_INSTANCE}/services/data/v59.0/sobjects/Account/${targetId}?fields=Important_Details_Notes__c`, {
              headers: { Authorization: `Bearer ${sfToken}` }
            })
            const leadData = await leadR.json()
            const currentNotes = leadData.Important_Details_Notes__c || ''

            await fetch(`${SF_INSTANCE}/services/data/v59.0/sobjects/Account/${targetId}`, {
              method: 'PATCH',
              headers: { Authorization: `Bearer ${sfToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ Important_Details_Notes__c: currentNotes + noteAppend })
            })
          } catch (err) {
            emailResult.errors.push(`Notes update: ${err.message}`)
          }
        }

        // Log to Supabase so we don't re-process
        try {
          await sb.from('finance_email_log').insert({
            email_id: email.id,
            from_domain: domain,
            subject: email.subject,
            customer_name: customerName,
            sf_contact_id: lead?.Id || null,
            pdfs_attached: emailResult.pdfsAttached,
            processed_at: new Date().toISOString(),
            error: emailResult.errors.join('; ') || null
          })
        } catch {}

        results.push(emailResult)
      }
    }

    res.json({
      checked: FINANCE_DOMAINS,
      newEmails: results.length,
      results
    })
  } catch (err) {
    console.error('GET /api/finance-emails:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── Lender domain → display name mapping ─────────────────────────────────────

const LENDER_MAP = {
  'theispc.com': 'ISPC',
  'foundationfinance.com': 'Foundation',
  'synchronybusiness.com': 'Synchrony',
  'aquafinance.com': 'Aqua',
  'fastfieldforms.com': 'FastField',
  'fastfield.com': 'FastField',
}

function lenderFromDomain(domain) {
  for (const [d, name] of Object.entries(LENDER_MAP)) {
    if (domain.includes(d)) return name
  }
  return domain
}

// ─── Sanitize SOQL input ───────────────────────────────────────────────────────

function soqlEscape(str) {
  return (str || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'")
}

// ─── GET /api/finance-emails/pending — manual review queue ─────────────────────

router.get('/finance-emails/pending', async (req, res) => {
  try {
    const token = await getGraphToken()
    const mailbox = process.env.MAILBOX_EMAIL || 'rebecca@rainsoftse.com'
    const sb = getSB()

    const pending = []

    for (const domain of FINANCE_DOMAINS) {
      const qs = new URLSearchParams({
        '$search': `"${domain}"`,
        '$top': '10',
        '$select': 'id,subject,receivedDateTime,from,bodyPreview,hasAttachments',
        '$orderby': 'receivedDateTime desc'
      })

      const r = await fetch(`https://graph.microsoft.com/v1.0/users/${mailbox}/messages?${qs}`, {
        headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' }
      })
      if (!r.ok) continue
      const data = await r.json()

      const emails = (data.value || []).filter(e => {
        const from = e.from?.emailAddress?.address?.toLowerCase() || ''
        return from.includes(domain)
      })

      for (const email of emails) {
        // Skip if already attached (has sf_contact_id + pdfs_attached)
        const { data: existing } = await sb.from('finance_email_log')
          .select('id,sf_contact_id,pdfs_attached')
          .eq('email_id', email.id)
          .maybeSingle()
        if (existing?.sf_contact_id && existing?.pdfs_attached?.length) continue

        if (!email.hasAttachments) continue

        // Fetch attachments
        const attR = await fetch(
          `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${email.id}/attachments?$select=id,name,contentType,size`,
          { headers: { Authorization: `Bearer ${token}` } }
        )
        if (!attR.ok) continue
        const attData = await attR.json()

        const pdfs = (attData.value || []).filter(a =>
          a.name?.toLowerCase().endsWith('.pdf') ||
          a.contentType?.toLowerCase().includes('pdf')
        ).map(a => ({ name: a.name, attachmentId: a.id, size: a.size }))

        if (!pdfs.length) continue

        const customerName = extractCustomerName(email.subject, email.bodyPreview || '')
        const approvalStatus = detectApproval(email.subject, email.bodyPreview || '')
        const amount = extractAmount(email.subject, email.bodyPreview || '')

        // Try to find suggested SF matches (top 3 across Account/Contact/Lead)
        let suggestedMatches = []
        if (customerName) {
          try {
            suggestedMatches = await searchSfRecords(customerName, 3)
          } catch { /* non-critical */ }
        }

        pending.push({
          emailId: email.id,
          subject: email.subject,
          from: email.from?.emailAddress?.address,
          lender: lenderFromDomain(domain),
          date: email.receivedDateTime,
          customerName,
          amount,
          approvalStatus,
          pdfs,
          suggestedMatches,
        })
      }
    }

    // Sort newest first
    pending.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())

    res.json(pending)
  } catch (err) {
    console.error('GET /api/finance-emails/pending:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/finance-emails/pdf/:emailId/:attachmentId — stream PDF ──────────

router.get('/finance-emails/pdf/:emailId/:attachmentId', async (req, res) => {
  try {
    const { emailId, attachmentId } = req.params
    const token = await getGraphToken()
    const mailbox = process.env.MAILBOX_EMAIL || 'rebecca@rainsoftse.com'

    const attR = await fetch(
      `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!attR.ok) return res.status(attR.status).json({ error: 'Failed to fetch attachment' })

    const att = await attR.json()

    if (!att.contentBytes) return res.status(404).json({ error: 'No content' })

    const buf = Buffer.from(att.contentBytes, 'base64')
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${att.name || 'document.pdf'}"`,
      'Content-Length': buf.length,
    })
    res.send(buf)
  } catch (err) {
    console.error('GET /api/finance-emails/pdf:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── Unified SF search: Accounts → Contacts → Leads ───────────────────────────

async function searchSfRecords(query, limit = 10) {
  const parts = query.trim().split(/\s+/)
  const firstName = soqlEscape(parts[0] || '')
  const lastName = soqlEscape(parts.slice(1).join(' ') || parts[0] || '')
  const fullName = soqlEscape(query.trim())

  const results = []

  // 1. Accounts (by Name)
  try {
    const accResult = await sfQuery(
      `SELECT Id, Name, Phone, BillingStreet, BillingCity, BillingState FROM Account WHERE Name LIKE '%${fullName}%' ORDER BY CreatedDate DESC LIMIT ${limit}`
    )
    for (const r of accResult.records || []) {
      results.push({
        Id: r.Id,
        objectType: 'Account',
        Name: r.Name,
        FirstName: null,
        LastName: null,
        Street: r.BillingStreet,
        City: r.BillingCity,
        State: r.BillingState,
        Phone: r.Phone,
      })
    }
  } catch { /* continue */ }

  // 2. Contacts (by FirstName + LastName)
  try {
    let contactSOQL
    if (parts.length > 1) {
      contactSOQL = `SELECT Id, FirstName, LastName, AccountId, Phone, MailingStreet, MailingCity, MailingState FROM Contact WHERE FirstName LIKE '%${firstName}%' AND LastName LIKE '%${lastName}%' ORDER BY CreatedDate DESC LIMIT ${limit}`
    } else {
      contactSOQL = `SELECT Id, FirstName, LastName, AccountId, Phone, MailingStreet, MailingCity, MailingState FROM Contact WHERE LastName LIKE '%${fullName}%' OR FirstName LIKE '%${fullName}%' ORDER BY CreatedDate DESC LIMIT ${limit}`
    }
    const conResult = await sfQuery(contactSOQL)
    for (const r of conResult.records || []) {
      results.push({
        Id: r.Id,
        objectType: 'Contact',
        Name: `${r.FirstName || ''} ${r.LastName || ''}`.trim(),
        FirstName: r.FirstName,
        LastName: r.LastName,
        AccountId: r.AccountId,
        Street: r.MailingStreet,
        City: r.MailingCity,
        State: r.MailingState,
        Phone: r.Phone,
      })
    }
  } catch { /* continue */ }

  // 3. Leads (fallback — not yet converted)
  try {
    let leadSOQL
    if (parts.length > 1) {
      leadSOQL = `SELECT Id, FirstName, LastName, Street, City, State, Phone, Status FROM Lead WHERE FirstName LIKE '%${firstName}%' AND LastName LIKE '%${lastName}%' ORDER BY CreatedDate DESC LIMIT ${limit}`
    } else {
      leadSOQL = `SELECT Id, FirstName, LastName, Street, City, State, Phone, Status FROM Lead WHERE LastName LIKE '%${fullName}%' OR FirstName LIKE '%${fullName}%' ORDER BY CreatedDate DESC LIMIT ${limit}`
    }
    const leadResult = await sfQuery(leadSOQL)
    for (const r of leadResult.records || []) {
      results.push({
        Id: r.Id,
        objectType: 'Lead',
        Name: `${r.FirstName || ''} ${r.LastName || ''}`.trim(),
        FirstName: r.FirstName,
        LastName: r.LastName,
        Street: r.Street,
        City: r.City,
        State: r.State,
        Phone: r.Phone,
        Status: r.Status,
      })
    }
  } catch { /* continue */ }

  return results.slice(0, limit)
}

// ─── GET /api/sf/search-records?q= — search Accounts, Contacts, Leads ────────

router.get('/sf/search-records', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim()
    if (!q || q.length < 2) return res.json([])

    const results = await searchSfRecords(q, 10)
    res.json(results)
  } catch (err) {
    console.error('GET /api/sf/search-records:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── POST /api/finance-emails/attach — attach PDF to SF record ────────────────

router.post('/finance-emails/attach', async (req, res) => {
  try {
    const { emailId, attachmentId, pdfName, sfRecordId, sfObjectType, lender } = req.body
    if (!emailId || !attachmentId || !sfRecordId) {
      return res.status(400).json({ error: 'Missing emailId, attachmentId, or sfRecordId' })
    }

    const token = await getGraphToken()
    const mailbox = process.env.MAILBOX_EMAIL || 'rebecca@rainsoftse.com'

    // 1. Download PDF from M365
    const attR = await fetch(
      `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!attR.ok) return res.status(500).json({ error: 'Failed to download PDF from M365' })
    const att = await attR.json()
    if (!att.contentBytes) return res.status(404).json({ error: 'No PDF content' })

    // 2. Attach to SF record as ContentVersion
    const sfToken = await getSfToken()
    const filename = pdfName || att.name || 'finance-doc.pdf'

    const cvBody = {
      Title: filename.replace('.pdf', ''),
      PathOnClient: filename,
      VersionData: att.contentBytes,
      FirstPublishLocationId: sfRecordId,  // works for Account, Contact, or Lead
    }
    const cvR = await fetch(`${SF_INSTANCE}/services/data/v59.0/sobjects/ContentVersion`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${sfToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cvBody)
    })
    const cvResult = await cvR.json()
    if (!cvResult.success) {
      return res.status(500).json({ error: `SF ContentVersion failed: ${JSON.stringify(cvResult)}` })
    }

    // 3. Log to Supabase
    const sb = getSB()
    try {
      // Upsert: update if already logged (partial), insert if new
      const { data: existing } = await sb.from('finance_email_log')
        .select('id,pdfs_attached')
        .eq('email_id', emailId)
        .maybeSingle()

      if (existing) {
        const attached = existing.pdfs_attached || []
        attached.push(filename)
        await sb.from('finance_email_log')
          .update({ sf_contact_id: sfRecordId, pdfs_attached: attached })
          .eq('id', existing.id)
      } else {
        await sb.from('finance_email_log').insert({
          email_id: emailId,
          from_domain: lender || 'unknown',
          subject: pdfName,
          customer_name: null,
          sf_contact_id: sfRecordId,
          pdfs_attached: [filename],
          processed_at: new Date().toISOString(),
          error: null,
        })
      }
    } catch { /* non-critical */ }

    res.json({
      ok: true,
      contentVersionId: cvResult.id,
      sfRecordId,
      sfObjectType: sfObjectType || 'unknown',
    })
  } catch (err) {
    console.error('POST /api/finance-emails/attach:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ═════════════════════════════════════════════════════════════════════════════
// JOURNEY CRM INTEGRATION — Link finance emails to customer records via deal data
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Match a customer name to a Journey CRM customer record using fuzzy matching.
 * Tries: exact name → last name + first initial → last name only
 */
async function findCrmCustomer(sb, customerName) {
  if (!customerName) return null

  // Parse name: handle "LAST, FIRST" and "FIRST LAST" formats
  const clean = customerName.trim()
  let firstName, lastName
  if (clean.includes(',')) {
    const parts = clean.split(',').map(s => s.trim())
    lastName = parts[0]
    firstName = parts[1]
  } else {
    const parts = clean.split(/\s+/)
    firstName = parts[0]
    lastName = parts.slice(1).join(' ')
  }
  if (!lastName) return null

  // Try exact last name + first name match
  const { data: exact } = await sb.from('customers')
    .select('id, name, first_name, last_name, email, phone, address, city, state, org_id')
    .ilike('last_name', lastName)
    .ilike('first_name', `${(firstName || '')[0]}%`)
    .order('created_at', { ascending: false })
    .limit(1)
  if (exact?.length) return exact[0]

  // Fallback: last name only
  const { data: lastOnly } = await sb.from('customers')
    .select('id, name, first_name, last_name, email, phone, address, city, state, org_id')
    .ilike('last_name', lastName)
    .order('created_at', { ascending: false })
    .limit(1)
  if (lastOnly?.length) return lastOnly[0]

  return null
}

/**
 * Match a customer name to a deal in finance_monitor_deals (ops dashboard PG).
 * Returns the deal with the most data (prefer numeric deal_id, most recent).
 */
async function findDealByName(db, customerName) {
  if (!customerName) return null

  const clean = customerName.trim().toUpperCase()
  let lastName, firstInitial
  if (clean.includes(',')) {
    const parts = clean.split(',').map(s => s.trim())
    lastName = parts[0]
    firstInitial = (parts[1] || '')[0]
  } else {
    const parts = clean.split(/\s+/)
    firstInitial = (parts[0] || '')[0]
    lastName = parts[parts.length - 1]
  }
  if (!lastName) return null

  const { rows } = await db.query(`
    SELECT * FROM finance_monitor_deals
    WHERE UPPER(SPLIT_PART(customer_name, ',', 1)) = $1
      AND UPPER(LEFT(TRIM(LEADING ' ' FROM SPLIT_PART(customer_name, ',', 2)), 1)) = $2
    ORDER BY
      CASE WHEN deal_id ~ '^[0-9]+$' THEN 0 ELSE 1 END,
      updated_at DESC NULLS LAST
    LIMIT 5
  `, [lastName, firstInitial])

  return rows.length > 0 ? rows : null
}

// ─── POST /api/finance-emails/link-to-crm — process finance emails and link to Journey CRM ──

router.post('/finance-emails/link-to-crm', async (req, res) => {
  try {
    const token = await getGraphToken()
    const mailbox = process.env.MAILBOX_EMAIL || 'rebecca@rainsoftse.com'
    const sb = getSB()
    const { getDb } = await import('./db/index.js')
    const db = getDb()

    // Ensure crm_customer_id column exists on finance_email_log
    try {
      await sb.rpc('exec_sql', { query: `ALTER TABLE finance_email_log ADD COLUMN IF NOT EXISTS crm_customer_id UUID` })
    } catch {
      // Column may already exist or rpc not available — non-fatal
    }

    const results = []
    const limit = parseInt(req.query.limit) || 10

    for (const domain of FINANCE_DOMAINS) {
      const qs = new URLSearchParams({
        '$search': `"${domain}"`,
        '$top': String(limit),
        '$select': 'id,subject,receivedDateTime,from,bodyPreview,hasAttachments',
        '$orderby': 'receivedDateTime desc'
      })

      const r = await fetch(`https://graph.microsoft.com/v1.0/users/${mailbox}/messages?${qs}`, {
        headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' }
      })
      if (!r.ok) continue
      const data = await r.json()

      const emails = (data.value || []).filter(e => {
        const from = e.from?.emailAddress?.address?.toLowerCase() || ''
        return from.includes(domain)
      })

      for (const email of emails) {
        // Skip if already linked to CRM
        const { data: existing } = await sb.from('finance_email_log')
          .select('id, crm_customer_id')
          .eq('email_id', email.id)
          .maybeSingle()
        if (existing?.crm_customer_id) continue

        const customerName = extractCustomerName(email.subject, email.bodyPreview || '')
        if (!customerName) continue

        const result = {
          emailId: email.id,
          subject: email.subject,
          from: email.from?.emailAddress?.address,
          date: email.receivedDateTime,
          customerName,
          lender: lenderFromDomain(domain),
          dealFound: false,
          crmCustomerFound: false,
          filesLinked: 0,
          errors: [],
        }

        // Step 1: Find matching deal(s) in ops dashboard
        const deals = await findDealByName(db, customerName)
        if (deals) {
          result.dealFound = true
          result.dealId = deals[0].deal_id
          result.portal = deals[0].portal
          result.dealStatus = deals[0].status
        }

        // Step 2: Find matching customer in Journey CRM
        const customer = await findCrmCustomer(sb, customerName)
        if (!customer) {
          result.errors.push('No matching customer in Journey CRM')
          results.push(result)
          continue
        }

        result.crmCustomerFound = true
        result.crmCustomerId = customer.id
        result.crmCustomerName = customer.name

        // Step 3: Log the email as a communication on the customer
        try {
          const approvalStatus = detectApproval(email.subject, email.bodyPreview || '')
          const amount = extractAmount(email.subject, email.bodyPreview || '')
          const summary = [
            `${result.lender} finance email`,
            approvalStatus !== 'unknown' ? `Decision: ${approvalStatus.toUpperCase()}` : null,
            amount ? `Amount: $${amount.toLocaleString()}` : null,
            result.dealId ? `Deal ID: ${result.dealId}` : null,
          ].filter(Boolean).join(' | ')

          await sb.from('communications').insert({
            org_id: customer.org_id,
            entity_type: 'customer',
            entity_id: customer.id,
            direction: 'inbound',
            provider: 'email',
            summary,
            transcript: `Subject: ${email.subject}\n\n${email.bodyPreview || ''}`,
            started_at: email.receivedDateTime,
            from_number: email.from?.emailAddress?.address,
          })
        } catch (err) {
          result.errors.push(`Communication log: ${err.message}`)
        }

        // Step 4: Download and attach PDFs to the customer record
        if (email.hasAttachments) {
          try {
            const attR = await fetch(
              `https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${email.id}/attachments`,
              { headers: { Authorization: `Bearer ${token}` } }
            )
            if (attR.ok) {
              const attData = await attR.json()
              const pdfs = (attData.value || []).filter(a =>
                a.name?.toLowerCase().endsWith('.pdf') ||
                a.contentType?.toLowerCase().includes('pdf')
              )

              for (const pdf of pdfs) {
                if (!pdf.contentBytes) continue
                try {
                  // Upload to Supabase Storage
                  const buf = Buffer.from(pdf.contentBytes, 'base64')
                  const safeName = (pdf.name || 'document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_')
                  const storagePath = `${customer.org_id}/customers/${customer.id}/${Date.now()}-${safeName}`

                  const { error: uploadErr } = await sb.storage
                    .from('crm-files')
                    .upload(storagePath, buf, {
                      contentType: pdf.contentType || 'application/pdf',
                      upsert: false,
                    })
                  if (uploadErr) throw uploadErr

                  // Create file record linked to customer
                  await sb.from('files').insert({
                    org_id: customer.org_id,
                    entity_type: 'customer',
                    entity_id: customer.id,
                    bucket_path: storagePath,
                    mime_type: pdf.contentType || 'application/pdf',
                    caption: `${result.lender} — ${pdf.name || 'Finance Document'}`,
                    uploaded_by: null, // system upload
                  })

                  result.filesLinked++
                } catch (err) {
                  result.errors.push(`PDF "${pdf.name}": ${err.message}`)
                }
              }
            }
          } catch (err) {
            result.errors.push(`Attachments: ${err.message}`)
          }
        }

        // Step 5: Update finance_email_log with CRM link
        try {
          if (existing) {
            await sb.from('finance_email_log')
              .update({ crm_customer_id: customer.id })
              .eq('id', existing.id)
          } else {
            await sb.from('finance_email_log').insert({
              email_id: email.id,
              from_domain: domain,
              subject: email.subject,
              customer_name: customerName,
              sf_contact_id: null,
              crm_customer_id: customer.id,
              pdfs_attached: [],
              processed_at: new Date().toISOString(),
              error: result.errors.join('; ') || null,
            })
          }
        } catch {}

        results.push(result)
      }
    }

    res.json({
      processed: results.length,
      linked: results.filter(r => r.crmCustomerFound).length,
      filesUploaded: results.reduce((sum, r) => sum + r.filesLinked, 0),
      results,
    })
  } catch (err) {
    console.error('POST /api/finance-emails/link-to-crm:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/finance-emails/crm-status — check linking status ───────────────

router.get('/finance-emails/crm-status', async (req, res) => {
  try {
    const sb = getSB()
    const { data: logs } = await sb.from('finance_email_log')
      .select('*')
      .not('crm_customer_id', 'is', null)
      .order('processed_at', { ascending: false })
      .limit(50)

    const { data: unlinked } = await sb.from('finance_email_log')
      .select('*')
      .is('crm_customer_id', null)
      .order('processed_at', { ascending: false })
      .limit(50)

    res.json({
      linked: logs?.length || 0,
      unlinked: unlinked?.length || 0,
      recentLinked: logs || [],
      recentUnlinked: unlinked || [],
    })
  } catch (err) {
    console.error('GET /api/finance-emails/crm-status:', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router
