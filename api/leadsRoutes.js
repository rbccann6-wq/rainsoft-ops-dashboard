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
      address: addrMatch ? addrMatch[1].replace(/\s+/g, ' ').trim() : '',
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

    // Fetch Lowe's appointment emails
    const qs = new URLSearchParams({
      $filter: "from/emailAddress/address eq 'do-not-reply@email.loweshomeservices.com'",
      $top: '20',
      $orderby: 'receivedDateTime desc',
      $select: 'id,subject,receivedDateTime,body,bodyPreview',
    })

    const resp = await withRetry(async () => {
      const r = await fetch(`https://graph.microsoft.com/v1.0/users/${mailbox}/messages?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!r.ok) throw new Error(`Graph ${r.status}`)
      return r.json()
    }, 'graph-fetch-lowe-emails')

    const emails = resp.value || []

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

    res.json({ leads: successful, errors: failed })
  } catch (err) {
    console.error('GET /api/leads:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/smartmail-leads — SmartMail scanned card leads ─────────────────

router.get('/smartmail-leads', async (req, res) => {
  try {
    const token = await withRetry(() => getGraphToken(), 'graph-token')
    const mailbox = process.env.MAILBOX_EMAIL

    // Fetch recent SmartMail emails with attachments
    const qs = new URLSearchParams({
      $filter: "from/emailAddress/address eq 'leads@smartmailgroup.com' and hasAttachments eq true",
      $top: '10',
      $orderby: 'receivedDateTime desc',
      $select: 'id,subject,receivedDateTime,hasAttachments',
    })

    const resp = await withRetry(async () => {
      const r = await fetch(`https://graph.microsoft.com/v1.0/users/${mailbox}/messages?${qs}`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!r.ok) throw new Error(`Graph ${r.status}`)
      return r.json()
    }, 'graph-fetch-smartmail-emails')

    const emails = resp.value || []

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
