/**
 * Finance Email Watcher
 * Scans inbox for emails from finance companies, extracts PDFs, attaches to Salesforce leads
 */

import express from 'express'
import { ConfidentialClientApplication } from '@azure/msal-node'
import { createClient } from '@supabase/supabase-js'

const router = express.Router()

const FINANCE_DOMAINS = ['theispc.com', 'foundationfinance.com', 'synchronybusiness.com', 'aquafinance.com']
const SF_INSTANCE = 'https://rainsoftse.my.salesforce.com'

function getSB() {
  return createClient(
    process.env.SUPABASE_URL || 'https://njqavagyuwdmkeyoscbz.supabase.co',
    process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5qcWF2YWd5dXdkbWtleW9zY2J6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Mzc1NTM4MywiZXhwIjoyMDg5MzMxMzgzfQ.67pxlJAlqIKgTgDwpoDBcQZ12ezT3ZPbQRXsBnRptPs'
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

let _sfToken = null, _sfExpiry = 0
async function getSfToken() {
  if (_sfToken && Date.now() < _sfExpiry) return _sfToken
  const soap = `<?xml version="1.0" encoding="utf-8"?><env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><n1:login xmlns:n1="urn:partner.soap.sforce.com"><n1:username>rebecca@rainsoftse.com</n1:username><n1:password>06RAPPAR.!</n1:password></n1:login></env:Body></env:Envelope>`
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

/** Find SF lead by customer name */
async function findSfLead(customerName) {
  if (!customerName) return null
  const parts = customerName.trim().split(' ')
  const firstName = parts[0]
  const lastName = parts.slice(1).join(' ')
  if (!lastName) return null

  try {
    const result = await sfQuery(
      `SELECT Id, FirstName, LastName FROM Lead WHERE FirstName = '${firstName.replace(/'/g,"\\'")}' AND LastName = '${lastName.replace(/'/g,"\\'")}' ORDER BY CreatedDate DESC LIMIT 1`
    )
    return result.totalSize > 0 ? result.records[0] : null
  } catch { return null }
}

/** Attach PDF to SF lead as ContentDocument */
async function attachPdfToLead(leadId, filename, pdfBase64) {
  const token = await getSfToken()

  // 1. Create ContentVersion
  const cvBody = {
    Title: filename.replace('.pdf', ''),
    PathOnClient: filename,
    VersionData: pdfBase64,
    FirstPublishLocationId: leadId,
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
        const lead = await findSfLead(customerName)

        const emailResult = {
          emailId: email.id,
          subject: email.subject,
          from: email.from?.emailAddress?.address,
          date: email.receivedDateTime,
          customerName,
          leadFound: !!lead,
          leadId: lead?.Id || null,
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
              await attachPdfToLead(lead.Id, pdf.name, pdf.contentBytes)
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
            const leadR = await fetch(`${SF_INSTANCE}/services/data/v59.0/sobjects/Lead/${lead.Id}?fields=Important_Details_Notes__c`, {
              headers: { Authorization: `Bearer ${sfToken}` }
            })
            const leadData = await leadR.json()
            const currentNotes = leadData.Important_Details_Notes__c || ''

            await fetch(`${SF_INSTANCE}/services/data/v59.0/sobjects/Lead/${lead.Id}`, {
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
            sf_lead_id: lead?.Id || null,
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

export default router
