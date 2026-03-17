import express from 'express'
import https from 'https'
import http from 'http'
import { ConfidentialClientApplication } from '@azure/msal-node'

const router = express.Router()

// ─── M365 auth (reuse pattern from emailRoutes) ───────────────────────────────

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

// ─── Retry helper (max 3 attempts) ───────────────────────────────────────────

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

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function httpsRequest(options, body = null) {
  return new Promise((resolve, reject) => {
    const mod = options.hostname?.startsWith('http://') ? http : https
    const req = (options.protocol === 'http:' ? http : https).request(options, res => {
      let data = ''
      res.on('data', d => data += d)
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }))
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

// ─── IME session cache ────────────────────────────────────────────────────────

let imeSession = null // { cookie, expiresAt }

async function getImeSession() {
  if (imeSession && Date.now() < imeSession.expiresAt) return imeSession.cookie

  return withRetry(async () => {
    // Step 1: GET login page for CSRF + session cookie
    const loginPage = await httpsRequest({
      hostname: 'apps.trustedhomeservices.com',
      path: '/account/login',
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh) Chrome/120' },
    })

    const csrfMatch = loginPage.body.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/)
    if (!csrfMatch) throw new Error('Could not find CSRF token on IME login page')
    const csrf = csrfMatch[1]

    const sidCookie = (loginPage.headers['set-cookie'] || []).find(c => c.includes('ASP.NET_SessionId'))
    const csrfCookie = (loginPage.headers['set-cookie'] || []).find(c => c.includes('__RequestVerificationToken'))
    const cookieHeader = [sidCookie, csrfCookie].filter(Boolean).map(c => c.split(';')[0]).join('; ')

    // Step 2: POST credentials
    const params = new URLSearchParams({
      __RequestVerificationToken: csrf,
      UserName: process.env.IME_USERNAME,
      Password: process.env.IME_PASSWORD,
      RememberMe: 'false',
    })
    const postBody = params.toString()

    const loginResp = await httpsRequest({
      hostname: 'apps.trustedhomeservices.com',
      path: '/account/login',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postBody),
        Cookie: cookieHeader,
        'User-Agent': 'Mozilla/5.0 (Macintosh) Chrome/120',
        Referer: 'https://apps.trustedhomeservices.com/account/login',
        Origin: 'https://apps.trustedhomeservices.com',
      },
    }, postBody)

    if (loginResp.status !== 302) throw new Error(`IME login returned ${loginResp.status}`)

    const authCookie = (loginResp.headers['set-cookie'] || []).find(c => c.includes('MIC_ID_PROD'))
    if (!authCookie) throw new Error('IME login did not return auth cookie')

    const fullCookie = cookieHeader + '; ' + authCookie.split(';')[0]
    imeSession = { cookie: fullCookie, expiresAt: Date.now() + 30 * 60 * 1000 } // 30 min
    return fullCookie
  }, 'IME-login')
}

// ─── Fetch WO details from IME ────────────────────────────────────────────────

async function fetchWorkOrder(woId) {
  return withRetry(async () => {
    const cookie = await getImeSession()
    const resp = await httpsRequest({
      hostname: 'apps.trustedhomeservices.com',
      path: `/workOrderNew/details?micWoId=${woId}`,
      method: 'GET',
      headers: {
        Cookie: cookie,
        'User-Agent': 'Mozilla/5.0 (Macintosh) Chrome/120',
        Referer: 'https://apps.trustedhomeservices.com/',
      },
    })

    if (resp.status === 302) {
      // Session expired — clear and retry
      imeSession = null
      throw new Error('IME session expired, will retry')
    }

    const html = resp.body
    const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')

    // Extract customer info
    const nameMatch = text.match(/(\d{8})\s+([A-Za-z]+\s+[A-Za-z]+)\s+Appt/)
    const cellMatch = text.match(/C:\s*\(?([\d\s\-\(\)]+)\)?(?=\s*O:|[A-Za-z])/)
    const officeMatch = text.match(/O:\s*\(?([\d\s\-\(\)]+)\)?(?=\s*[a-z@])/)
    const emailMatch = text.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/)
    const addrMatch = text.match(/Project Address\s+([\d][^C]+?)(?:Cancel|Add Billing|Special)/)
    const storeMatch = text.match(/Store\s+([\d]+\s+[^\n]+?(?:FL|AL|GA|TN|MS)(?:\s*\(\d+\))?)/)
    const statusMatch = text.match(/Appt Pending|Appointment Pending|Scheduled|Completed|Cancelled/i)

    return {
      woId,
      customerName: nameMatch ? nameMatch[2].trim() : 'Unknown',
      phone: cellMatch ? cellMatch[1].trim() : '',
      officePhone: officeMatch ? officeMatch[1].trim() : '',
      email: emailMatch ? emailMatch[1] : '',
      address: addrMatch ? addrMatch[1].replace(/\s+/g, ' ').replace(/function\s+\w+\(.*$/s, '').trim() : '',
      store: storeMatch ? storeMatch[1].trim() : '',
      status: statusMatch ? statusMatch[0] : 'Appointment Pending',
    }
  }, `IME-WO-${woId}`)
}

// ─── GET /api/leads — Lowe's IME leads ───────────────────────────────────────

router.get('/leads', async (req, res) => {
  try {
    const token = await withRetry(() => getGraphToken(), 'graph-token')
    const mailbox = process.env.MAILBOX_EMAIL

    // Fetch Lowe's appointment emails — use $search instead of $filter (filter on from requires special index)
    const qs = new URLSearchParams({
      $search: '"loweshomeservices"',
      $top: '20',
      $select: 'id,subject,receivedDateTime,body,bodyPreview,from',
    })

    const resp = await withRetry(async () => {
      const r = await fetch(`https://graph.microsoft.com/v1.0/users/${mailbox}/messages?${qs}`, {
        headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' },
      })
      if (!r.ok) throw new Error(`Graph ${r.status}: ${await r.text()}`)
      return r.json()
    }, 'graph-fetch-lowe-emails')

    // Filter to only Lowe's sender emails
    const emails = (resp.value || []).filter(e =>
      e.from?.emailAddress?.address?.toLowerCase().includes('lowes')
    )

    // Extract WO IDs
    const woEmails = emails.map(email => {
      const text = email.body?.content || email.bodyPreview || ''
      const woMatch = text.match(/WO\s*#?\s*(\d{7,9})/i) ||
                      text.match(/micWoId[=\s]+(\d{7,9})/i) ||
                      email.subject.match(/WO\s*#?\s*(\d{7,9})/i)
      return { email, woId: woMatch ? woMatch[1] : null }
    }).filter(x => x.woId)

    // Fetch WO details (cap at 10 to avoid hammering IME)
    const leads = await Promise.allSettled(
      woEmails.slice(0, 10).map(async ({ email, woId }) => {
        const wo = await fetchWorkOrder(woId)
        return {
          ...wo,
          emailDate: email.receivedDateTime,
          emailId: email.id,
        }
      })
    )

    const successful = leads
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)

    const failed = leads
      .filter(r => r.status === 'rejected')
      .map(r => r.reason?.message)

    // Auto-sync new leads to Salesforce (fire and forget — don't block response)
    syncLeadsToSalesforce(successful).catch(err =>
      console.error('[SF sync] Failed:', err.message)
    )

    res.json({ leads: successful, errors: failed })
  } catch (err) {
    console.error('GET /api/leads:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── Salesforce auto-sync ─────────────────────────────────────────────────────

const SF_INSTANCE = 'https://rainsoftse.my.salesforce.com'
const LOWES_LEAD_RT = '012Rl000007imrJIAQ'
let sfToken = null
let sfTokenExpiry = 0

async function getSfToken() {
  if (sfToken && Date.now() < sfTokenExpiry) return sfToken
  const soap = `<?xml version="1.0" encoding="utf-8"?><env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><n1:login xmlns:n1="urn:partner.soap.sforce.com"><n1:username>rebecca@rainsoftse.com</n1:username><n1:password>06RAPPAR.!</n1:password></n1:login></env:Body></env:Envelope>`
  const r = await fetch('https://login.salesforce.com/services/Soap/u/59.0', {
    method: 'POST', headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: 'login' }, body: soap
  })
  const text = await r.text()
  const match = text.match(/<sessionId>([^<]+)<\/sessionId>/)
  if (!match) throw new Error('SF login failed')
  sfToken = match[1]
  sfTokenExpiry = Date.now() + 55 * 60 * 1000 // 55 min
  return sfToken
}

async function sfQuery(soql) {
  const token = await getSfToken()
  const r = await fetch(`${SF_INSTANCE}/services/data/v59.0/query?q=${encodeURIComponent(soql)}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!r.ok) throw new Error(`SF query ${r.status}`)
  return r.json()
}

async function sfCreate(obj, data) {
  const token = await getSfToken()
  const r = await fetch(`${SF_INSTANCE}/services/data/v59.0/sobjects/${obj}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  })
  return r.json()
}

async function syncLeadsToSalesforce(leads) {
  let created = 0
  for (const lead of leads) {
    if (!lead.woId) continue
    try {
      // Check if already synced (check Leads object)
      const existing = await sfQuery(
        `SELECT Id FROM Lead WHERE Important_Details_Notes__c LIKE '%WO#${lead.woId}%' LIMIT 1`
      )
      if (existing.totalSize > 0) continue

      const nameParts = (lead.customerName || '').trim().split(' ')
      const firstName = nameParts[0] || ''
      const lastName = nameParts.slice(1).join(' ') || firstName

      // Parse address into components
      const addr = (lead.address || '').trim()
      const addrMatch = addr.match(/^(.*?)\s+([A-Za-z\s]+)\s+([A-Z]{2})\s+(\d{5})$/)

      const record = {
        RecordTypeId: LOWES_LEAD_RT,
        FirstName: firstName,
        LastName: lastName,
        LeadSource: 'Lowes',
        Lead_Source_Specific__c: 'Lowes',
        Gift__c: 'Other',
        Phone: lead.phone || '',
        Email: lead.email || '',
        Status: 'New',
        Important_Details_Notes__c: `Direct Lowe's Lead | WO#${lead.woId} | Store: ${lead.store || ''}`,
        CountryCode: 'US',
      }

      if (addrMatch) {
        record.Street     = addrMatch[1].trim()
        record.City       = addrMatch[2].trim()
        record.StateCode  = addrMatch[3].trim()
        record.PostalCode = addrMatch[4].trim()
      } else if (addr) {
        record.Street = addr
      }

      const result = await sfCreate('Lead', record)
      if (result.success) {
        console.log(`[SF sync] Created Lead: ${lead.customerName} WO#${lead.woId} → ${result.id}`)
        created++
      } else {
        console.warn(`[SF sync] Failed ${lead.woId}:`, JSON.stringify(result).slice(0, 150))
      }
    } catch (err) {
      console.error(`[SF sync] Error for WO#${lead.woId}:`, err.message)
    }
  }
  if (created > 0) console.log(`[SF sync] Synced ${created} new Lowe's leads to Salesforce`)
}

// ─── GET /api/smartmail-leads — SmartMail scanned card leads ─────────────────

router.get('/smartmail-leads', async (req, res) => {
  try {
    const token = await withRetry(() => getGraphToken(), 'graph-token')
    const mailbox = process.env.MAILBOX_EMAIL

    // Fetch recent SmartMail emails — use $search for reliability
    const qs = new URLSearchParams({
      $search: '"smartmailgroup"',
      $top: '10',
      $select: 'id,subject,receivedDateTime,hasAttachments,from',
    })

    const resp = await withRetry(async () => {
      const r = await fetch(`https://graph.microsoft.com/v1.0/users/${mailbox}/messages?${qs}`, {
        headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' },
      })
      if (!r.ok) throw new Error(`Graph ${r.status}: ${await r.text()}`)
      return r.json()
    }, 'graph-fetch-smartmail-emails')

    // Filter to only SmartMail sender emails
    const emails = (resp.value || []).filter(e =>
      e.from?.emailAddress?.address?.toLowerCase().includes('smartmail')
    )

    // Return email metadata — OCR processing happens on demand
    const result = emails.map(e => ({
      emailId: e.id,
      subject: e.subject,
      date: e.receivedDateTime,
      status: 'pdf_ready', // OCR not yet run
    }))

    res.json({ batches: result })
  } catch (err) {
    console.error('GET /api/smartmail-leads:', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router
