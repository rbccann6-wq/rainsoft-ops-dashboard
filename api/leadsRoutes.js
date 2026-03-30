import express from 'express'
import https from 'https'
import http from 'http'
import { ConfidentialClientApplication } from '@azure/msal-node'
import { createClient } from '@supabase/supabase-js'

function getSB() {
  return createClient(
    process.env.SUPABASE_URL || 'https://njqavagyuwdmkeyoscbz.supabase.co',
    process.env.SUPABASE_SERVICE_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5qcWF2YWd5dXdkbWtleW9zY2J6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Mzc1NTM4MywiZXhwIjoyMDg5MzMxMzgzfQ.67pxlJAlqIKgTgDwpoDBcQZ12ezT3ZPbQRXsBnRptPs'
  )
}

const router = express.Router()

// ─── Auto-migrate: add duplicate tracking columns to lowes_leads_cache ────────
;(async () => {
  try {
    const sb = getSB()
    // Test if columns exist by reading them
    const { error } = await sb.from('lowes_leads_cache').select('duplicate_sf_id,duplicate_type').limit(1)
    if (error && error.message?.includes('duplicate_sf_id')) {
      console.log('[migrate] Adding duplicate_sf_id & duplicate_type columns to lowes_leads_cache...')
      // Columns don't exist — use raw SQL via a temp RPC function
      const { error: fnErr } = await sb.rpc('exec_sql', {
        query: `ALTER TABLE lowes_leads_cache ADD COLUMN IF NOT EXISTS duplicate_sf_id text; ALTER TABLE lowes_leads_cache ADD COLUMN IF NOT EXISTS duplicate_type text;`
      })
      if (fnErr) {
        console.warn('[migrate] Could not auto-add columns (add manually):', fnErr.message)
        console.warn('[migrate] Run this SQL in Supabase dashboard:')
        console.warn('[migrate]   ALTER TABLE lowes_leads_cache ADD COLUMN IF NOT EXISTS duplicate_sf_id text;')
        console.warn('[migrate]   ALTER TABLE lowes_leads_cache ADD COLUMN IF NOT EXISTS duplicate_type text;')
      } else {
        console.log('[migrate] Columns added successfully')
      }
    } else {
      console.log('[leads] duplicate tracking columns OK')
    }
  } catch (err) {
    console.warn('[migrate] Migration check failed:', err.message)
  }
})()

// Normalize US phone to (XXX) XXX-XXXX display format
function normalizePhone(raw) {
  if (!raw) return ''
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `(${digits.slice(0,3)}) ${digits.slice(3,6)}-${digits.slice(6)}`
  if (digits.length === 11 && digits.startsWith('1')) return `(${digits.slice(1,4)}) ${digits.slice(4,7)}-${digits.slice(7)}`
  return raw.trim()
}

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
    // Decode &nbsp; and other HTML entities BEFORE stripping tags
    const text = html
      .replace(/&nbsp;/g, ' ')
      .replace(/&#160;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')

    // Extract customer info
    const nameMatch = text.match(/([A-Za-z]+\s+[A-Za-z]+)\s+Appt\s+Pending/) ||
                      text.match(/Customer Information\s+([A-Za-z]+\s+[A-Za-z]+)\s/)
    // Phone: handles C: (xxx) xxx-xxxx or C: xxxxxxxxxx with optional &nbsp; already decoded
    const cellMatch = text.match(/C:\s*(\(?\d{3}\)?[\s\-\.]\d{3}[\s\-\.]\d{4})/) 
    const homeMatch = text.match(/H:\s*(\(?\d{3}\)?[\s\-\.]\d{3}[\s\-\.]\d{4})/)
    const officeMatch = text.match(/O:\s*(\(?\d{3}\)?[\s\-\.]\d{3}[\s\-\.]\d{4})/)
    // Use first available phone: cell > home > office
    const bestPhone = cellMatch?.[1] || homeMatch?.[1] || officeMatch?.[1] || ''
    const emailMatch = text.match(/([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/)
    const addrMatch = text.match(/Project Address\s+([\d][^C]+?)(?:Cancel|Add Billing|Special)/)
    const storeMatch = text.match(/Store\s+([\d]+\s+[^\n]+?(?:FL|AL|GA|TN|MS)(?:\s*\(\d+\))?)/)
    const statusMatch = text.match(/Appt Pending|Appointment Pending|Scheduled|Completed|Cancelled/i)

    return {
      woId,
      customerName: nameMatch ? nameMatch[1].trim() : 'Unknown',
      phone: normalizePhone(bestPhone),
      officePhone: normalizePhone(officeMatch ? officeMatch[1] : ''),
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
        const sb = getSB()

        // Check cache first — avoids re-calling IME and Rentcast on every page view
        // Note: .single() returns error (not null) when no row exists — check data explicitly
        const { data: cached, error: cacheErr } = await sb.from('lowes_leads_cache').select('*').eq('wo_id', woId).maybeSingle()
        if (cached) {
          return {
            woId: cached.wo_id,
            customerName: cached.customer_name,
            phone: cached.phone,
            officePhone: cached.office_phone,
            email: cached.email,
            address: cached.address,
            store: cached.store,
            status: cached.status,
            emailDate: email.receivedDateTime,
            emailId: email.id,
            rentcast: cached.rentcast,
            sfLeadId: cached.sf_lead_id || null,
            duplicateSfId: cached.duplicate_sf_id || null,
            duplicateType: cached.duplicate_type || null,
          }
        }

        // Not cached — fetch from IME + Rentcast
        const wo = await fetchWorkOrder(woId)
        const addrParsed = parseAddress(wo.address)
        const rentcast = await getRentcastData(addrParsed.street, addrParsed.city, addrParsed.state, addrParsed.zip).catch(() => null)

        // Save to cache
        try {
          await sb.from('lowes_leads_cache').upsert({
            wo_id: woId,
            customer_name: wo.customerName,
            phone: wo.phone,
            office_phone: wo.officePhone,
            email: wo.email,
            address: wo.address,
            store: wo.store,
            status: wo.status,
            rentcast: rentcast || null,
          }, { onConflict: 'wo_id' })
        } catch {}

        return {
          ...wo,
          emailDate: email.receivedDateTime,
          emailId: email.id,
          rentcast,
        }
      })
    )

    const successful = leads
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)

    const failed = leads
      .filter(r => r.status === 'rejected')
      .map(r => r.reason?.message)

    // Only sync new leads (not in cache yet) — never re-sync known WO#s
    const sb = getSB()
    const knownIds = new Set()
    for (const lead of successful) {
      if (!lead.woId) continue
      const { data } = await sb.from('lowes_leads_cache').select('sf_lead_id').eq('wo_id', lead.woId).maybeSingle()
      if (data?.sf_lead_id) knownIds.add(lead.woId)
    }
    const newLeads = successful.filter(l => l.woId && !knownIds.has(l.woId))

    const sfIdMap = newLeads.length > 0
      ? await syncLeadsToSalesforce(successful).catch(err => {
          console.error('[SF sync] Failed:', err.message)
          return {}
        })
      : {}

    // Build final response with SF IDs from cache + any newly synced
    const leadsWithSf = successful.map(l => ({
      ...l,
      sfLeadId: l.sfLeadId || sfIdMap[l.woId] || null,
    }))

    res.json({ leads: leadsWithSf, errors: failed })
  } catch (err) {
    console.error('GET /api/leads:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/leads/check-new — lightweight check for new WO#s (no Rentcast, no IME) ──
router.get('/leads/check-new', async (req, res) => {
  try {
    const token = await withRetry(() => getGraphToken(), 'graph-token')
    const mailbox = process.env.MAILBOX_EMAIL
    const sb = getSB()

    // Fetch recent Lowe's email subjects only (no body, no attachments)
    const qs = new URLSearchParams({ '$search': '"loweshomeservices"', '$top': '10', '$select': 'id,subject' })
    const r = await fetch(`https://graph.microsoft.com/v1.0/users/${mailbox}/messages?${qs}`, {
      headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' }
    })
    if (!r.ok) return res.json({ newCount: 0 })
    const data = await r.json()

    // Extract WO numbers from subjects
    const woIds = []
    for (const msg of (data.value || []).filter(m => m.from?.emailAddress?.address?.includes('lowes') || m.subject?.includes('WO'))) {
      const match = msg.subject?.match(/WO\s*#?\s*(\d{7,9})/i)
      if (match) woIds.push(match[1])
    }

    if (!woIds.length) return res.json({ newCount: 0 })

    // Check which ones are NOT in cache
    const { data: cached } = await sb.from('lowes_leads_cache').select('wo_id').in('wo_id', woIds)
    const cachedIds = new Set((cached || []).map(r => r.wo_id))
    const newCount = woIds.filter(id => !cachedIds.has(id)).length

    res.json({ newCount })
  } catch (err) {
    res.json({ newCount: 0 })
  }
})

// ─── Salesforce auto-sync ─────────────────────────────────────────────────────

const SF_INSTANCE = 'https://rainsoftse.my.salesforce.com'
const LOWES_LEAD_RT = '012Rl000007imrJIAQ'
const RENTCAST_KEY = process.env.RENTCAST_API_KEY || '85cb3067516d4fbbac2693c806367dc2'

function parseAddress(raw) {
  if (!raw) return {}
  // Try "123 Main St City ST 12345" pattern
  const m = raw.match(/^(.*?)\s+([A-Za-z\s]+)\s+([A-Z]{2})\s+(\d{5})$/)
  if (m) return { street: m[1].trim(), city: m[2].trim(), state: m[3], zip: m[4] }
  // Try without zip
  const m2 = raw.match(/^(.*?)\s+([A-Za-z\s]+)\s+([A-Z]{2})$/)
  if (m2) return { street: m2[1].trim(), city: m2[2].trim(), state: m2[3], zip: '' }
  return { street: raw }
}

// Hard lock: track every address called — never call twice regardless of cache state
const _rentcastCalled = new Set()

async function getRentcastData(address, city, state, zip) {
  if (!address) return null
  const key = [address, city, state].filter(Boolean).join(',').toLowerCase().trim()
  
  // Layer 1: in-memory dedup — never call same address twice in this server session
  if (_rentcastCalled.has(key)) {
    console.log(`[rentcast] BLOCKED (in-memory): ${key}`)
    return null
  }
  
  // Layer 2: check Supabase cache — if this address was ever fetched, skip API call
  try {
    const sb = getSB()
    const { data } = await sb.from('lowes_leads_cache').select('rentcast').ilike('address', `%${address}%`).maybeSingle()
    if (data?.rentcast) {
      console.log(`[rentcast] HIT (supabase): ${key}`)
      _rentcastCalled.add(key)
      return data.rentcast
    }
  } catch {}
  
  _rentcastCalled.add(key)
  console.log(`[rentcast] CALLING API: ${key}`)
  const fullAddr = [address, city, state, zip].filter(Boolean).join(', ')
  const result = { price: null, low: null, high: null, owner: null, ownerOccupied: null, lastSaleDate: null, lastSalePrice: null, sqft: null, beds: null, baths: null, yearBuilt: null }
  try {
    const r1 = await fetch(`https://api.rentcast.io/v1/properties?address=${encodeURIComponent(fullAddr)}`, {
      headers: { 'X-Api-Key': RENTCAST_KEY, Accept: 'application/json' }
    })
    if (r1.ok) {
      const d1 = await r1.json()
      const prop = Array.isArray(d1) ? d1[0] : null
      if (prop) {
        result.owner = prop.owner?.names?.join(', ') || null
        result.ownerOccupied = prop.ownerOccupied ?? null
        result.sqft = prop.squareFootage || null
        result.beds = prop.bedrooms || null
        result.baths = prop.bathrooms || null
        result.yearBuilt = prop.yearBuilt || null
        result.lastSaleDate = prop.lastSaleDate?.slice(0,10) || null
        result.lastSalePrice = prop.lastSalePrice || null
      }
    }
  } catch {}
  try {
    const r2 = await fetch(`https://api.rentcast.io/v1/avm/value?address=${encodeURIComponent(fullAddr)}&propertyType=Single+Family`, {
      headers: { 'X-Api-Key': RENTCAST_KEY, Accept: 'application/json' }
    })
    if (r2.ok) {
      const d2 = await r2.json()
      result.price = d2.price || null
      result.low = d2.priceRangeLow || null
      result.high = d2.priceRangeHigh || null
    }
  } catch {}
  return result
}
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
  const sfIdMap = {}  // woId → sfLeadId

  // First pass: check cache for SF IDs (avoids SF queries on every load)
  const sb = getSB()
  for (const lead of leads) {
    if (!lead.woId) continue
    // Check cache first
    if (lead.sfLeadId) { sfIdMap[lead.woId] = lead.sfLeadId; continue }
    try {
      const { data: cached } = await sb.from('lowes_leads_cache').select('sf_lead_id').eq('wo_id', lead.woId).single()
      if (cached?.sf_lead_id) { sfIdMap[lead.woId] = cached.sf_lead_id; continue }
      // Fall back to SF query
      const existing = await sfQuery(
        `SELECT Id FROM Lead WHERE Important_Details_Notes__c LIKE '%WO#${lead.woId}%' LIMIT 1`
      )
      if (existing.totalSize > 0) {
        sfIdMap[lead.woId] = existing.records[0].Id
        try { await sb.from('lowes_leads_cache').update({ sf_lead_id: existing.records[0].Id }).eq('wo_id', lead.woId) } catch {}
      }
    } catch {}
  }

  for (const lead of leads) {
    if (!lead.woId) continue
    try {
      // Already found in first pass
      if (sfIdMap[lead.woId]) continue

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
        Gift__c: '$20 Lowes GC',
        Phone: lead.phone || '',
        Email: lead.email || '',
        Status: 'New',
        Important_Details_Notes__c: [
          `Direct Lowe's Lead | WO#${lead.woId} | Store: ${lead.store || ''}`,
          lead.rentcast?.owner        ? `Record Owner: ${lead.rentcast.owner}` : null,
          lead.rentcast?.ownerOccupied != null ? `Owner-Occupied: ${lead.rentcast.ownerOccupied ? 'Yes' : 'No'}` : null,
          lead.rentcast?.price        ? `Est. Value: $${Number(lead.rentcast.price).toLocaleString()}` : null,
          lead.rentcast?.lastSalePrice ? `Last Sale: $${Number(lead.rentcast.lastSalePrice).toLocaleString()}${lead.rentcast.lastSaleDate ? ` (${lead.rentcast.lastSaleDate})` : ''}` : null,
          lead.rentcast?.sqft         ? `${lead.rentcast.sqft.toLocaleString()} sqft` : null,
          lead.rentcast?.beds         ? `${lead.rentcast.beds} bed` : null,
          lead.rentcast?.baths        ? `${lead.rentcast.baths} bath` : null,
          lead.rentcast?.yearBuilt    ? `Built ${lead.rentcast.yearBuilt}` : null,
        ].filter(Boolean).join(' | '),
        CountryCode: 'US',
        // Property fields from Rentcast
        ...(lead.rentcast?.price        ? { Home_Value__c: lead.rentcast.price } : {}),
        ...(lead.rentcast?.ownerOccupied === true ? { Homeowner__c: 'Yes', Homeowner_Verified__c: true } : {}),
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
        sfIdMap[lead.woId] = result.id
        created++
        // Update cache with SF lead ID
        try { await getSB().from('lowes_leads_cache').update({ sf_lead_id: result.id }).eq('wo_id', lead.woId) } catch {}
      } else {
        // Check for duplicate detection
        const dupResult = Array.isArray(result) ? result[0] : result
        if (dupResult?.errorCode === 'DUPLICATES_DETECTED') {
          const matchResult = dupResult.duplicateResult?.matchResults?.[0]
          const entityType = matchResult?.entityType || 'Unknown'
          const dupId = matchResult?.matchRecords?.[0]?.record?.Id || null
          console.log(`[SF sync] Duplicate detected for WO#${lead.woId}: ${entityType} ${dupId}`)
          if (dupId) {
            try {
              await getSB().from('lowes_leads_cache').update({
                duplicate_sf_id: dupId,
                duplicate_type: entityType,
              }).eq('wo_id', lead.woId)
            } catch (e) {
              console.warn(`[SF sync] Could not save duplicate info for WO#${lead.woId}:`, e.message)
            }
          }
        } else {
          console.warn(`[SF sync] Failed ${lead.woId}:`, JSON.stringify(result).slice(0, 150))
        }
      }
    } catch (err) {
      console.error(`[SF sync] Error for WO#${lead.woId}:`, err.message)
    }
  }
  if (created > 0) console.log(`[SF sync] Synced ${created} new Lowe's leads to Salesforce`)
  return sfIdMap
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

    // Check which batches have already been processed in Supabase
    const sb = getSB()
    const emailIds = emails.map(e => e.id)
    const { data: processed } = await sb
      .from('smartmail_leads')
      .select('batch_id')
      .in('batch_id', emailIds)
    const processedIds = new Set((processed || []).map(r => r.batch_id))

    // Only return batches not yet processed
    const result = emails
      .filter(e => !processedIds.has(e.id))
      .map(e => ({
        emailId: e.id,
        subject: e.subject,
        date: e.receivedDateTime,
        status: 'pdf_ready',
      }))

    res.json({ batches: result })
  } catch (err) {
    console.error('GET /api/smartmail-leads:', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router
