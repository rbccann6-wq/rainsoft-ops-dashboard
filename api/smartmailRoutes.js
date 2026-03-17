/**
 * SmartMail Bottle Drop Lead Processing
 * Downloads PDFs → Claude vision OCR → verification → Salesforce push
 */

import express from 'express'
// execSync removed — no longer needed (Claude reads PDF natively)
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'
import { ConfidentialClientApplication } from '@azure/msal-node'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const router = express.Router()
const DATA_DIR = path.join(__dirname, '..', 'data', 'smartmail')
const SF_INSTANCE = 'https://rainsoftse.my.salesforce.com'
const BOTTLE_DROP_RT = '01236000001QBeKAAW'
const RENTCAST_KEY = process.env.RENTCAST_API_KEY || '85cb3067516d4fbbac2693c806367dc2'

// ── Clients ───────────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

async function getRentcastData(address, city, state, zip) {
  if (!address || !city || !state) return null
  const fullAddr = [address, city, state, zip].filter(Boolean).join(', ')
  const result = { price: null, low: null, high: null, owner: null, ownerOccupied: null, taxAssessed: null, lastSaleDate: null, lastSalePrice: null, sqft: null, beds: null, baths: null, yearBuilt: null }

  try {
    // 1. Property record (owner, tax, sale history)
    const r1 = await fetch(`https://api.rentcast.io/v1/properties?` + new URLSearchParams({ address: fullAddr }), {
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
        // Latest tax assessment
        const tax = prop.taxAssessments || {}
        const latestYear = Object.keys(tax).sort().pop()
        if (latestYear) result.taxAssessed = tax[latestYear]?.value || null
      }
    }
  } catch {}

  try {
    // 2. AVM estimated value
    const r2 = await fetch(`https://api.rentcast.io/v1/avm/value?` + new URLSearchParams({ address: fullAddr, propertyType: 'Single Family' }), {
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

async function withRetry(fn, max = 3) {
  let err
  for (let i = 1; i <= max; i++) {
    try { return await fn() } catch (e) { err = e; if (i < max) await new Promise(r => setTimeout(r, 1000 * i)) }
  }
  throw err
}

import { createRequire as _cr } from 'module'
import dns from 'dns'
import { promisify } from 'util'
const dnsLookup = promisify(dns.lookup)

const AL_AC = new Set(['205','251','256','334','938'])
const FL_AC = new Set(['239','305','321','352','386','407','448','561','689','727','754','772','786','813','850','863','904','941','954'])
const STATE_AC = { AL: AL_AC, FL: FL_AC }

/** Cross-check handwritten name vs printed mailing label (ignoring middle initial) */
function checkNameMatch(handwritten, printed) {
  if (!handwritten || !printed) return null
  const hw = handwritten.toLowerCase().trim().split(/\s+/)
  const pr = printed.toLowerCase().trim().split(/\s+/)
  return hw[0] === pr[0] && hw[hw.length-1] === pr[pr.length-1]
}

/** Cross-check handwritten address vs printed label (street number must match) */
function checkAddrMatch(handwritten, printed) {
  if (!handwritten || !printed) return null
  const hwNum = handwritten.trim().match(/^(\d+)/)
  const prNum = printed.trim().match(/^(\d+)/)
  return hwNum && prNum ? hwNum[1] === prNum[1] : null
}

/** Validate phone format + area code matches state */
function checkPhone(phone, state) {
  if (!phone) return { phone_valid: null, area_code_match: null }
  const digits = phone.replace(/\D/g, '')
  const phone_valid = digits.length === 10
  const ac = digits.slice(0, 3)
  const codes = STATE_AC[state?.toUpperCase()]
  const area_code_match = codes ? codes.has(ac) : null
  return { phone_valid, area_code_match }
}

/** DNS lookup to confirm email domain exists and can receive mail */
async function checkEmailDomain(email) {
  if (!email) return null
  const domain = email.split('@')[1]?.toLowerCase()
  if (!domain) return false
  try {
    await dnsLookup(domain)
    return true
  } catch {
    return false
  }
}

async function verify(lead, printedName, printedAddr) {
  const name_match = checkNameMatch(lead.full_name, printedName)
  const addr_match = checkAddrMatch(lead.address, printedAddr)
  const { phone_valid, area_code_match } = checkPhone(lead.phone, lead.state)
  const email_valid = await checkEmailDomain(lead.email)

  const checks = [name_match, addr_match, phone_valid, area_code_match, email_valid].filter(v => v !== null)
  const passed = checks.filter(Boolean).length
  const total  = checks.length

  let confidence = 'Flag'
  if (passed === total && total >= 3) confidence = 'High'
  else if (passed >= 3) confidence = 'Medium'
  else if (passed >= 2) confidence = 'Low'

  return { name_match, addr_match, phone_valid, area_code_match, email_valid, confidence, score: `${passed}/${total}` }
}

// ── PDF → images using Python ─────────────────────────────────────────────────

// ── Claude native PDF OCR (no image conversion needed) ───────────────────────
// Passes the entire PDF to Claude with the PDF beta feature.
// Claude reads all pages and returns an array of lead objects.

async function ocrPdfAllPages(pdfPath) {
  const pdfData = fs.readFileSync(pdfPath).toString('base64')

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'pdfs-2024-09-25',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfData } },
          { type: 'text', text: `This PDF contains multiple water test lead cards, one per page. Extract data from EVERY page that has a filled-out lead card (skip blank pages or envelope pages).

Return a JSON array where each element represents one lead card with these fields:
full_name (handwritten name), address (handwritten street only), city, state (2-letter), zip, phone, email,
water_source ("City" or "Well"), buys_bottled_water ("Yes"/"No"), homeowner ("Yes"/"No" or null),
water_conditions (array from: Chlorine Smell, Brown Stains, Scale Deposits, Rotten Smell, Cloudiness),
water_quality ("Good"/"Fair"/"Poor"), filtration (array from: Refrigerator, Whole Home, Sink, None),
tds (number or null), hd (number or null), ph (number or null),
sample_date (string or null), printed_name (PRINTED name from mailing label), printed_address (PRINTED street from mailing label).

Use null for missing fields. Return ONLY the JSON array, no explanation.` }
        ]
      }]
    })
  })

  if (!r.ok) {
    const err = await r.text()
    throw new Error(`Claude PDF API ${r.status}: ${err.slice(0, 200)}`)
  }

  const d = await r.json()
  const text = d.content?.[0]?.text || ''
  const jsonMatch = text.match(/\[[\s\S]*\]/)
  if (!jsonMatch) throw new Error(`No JSON array in Claude response: ${text.slice(0, 200)}`)

  const leads = JSON.parse(jsonMatch[0])
  return leads.filter(l => l.full_name) // skip blank entries
}

// ── Download PDF from M365 ────────────────────────────────────────────────────

async function downloadPdf(emailId, outPath) {
  const token = await getGraphToken()
  const mailbox = process.env.MAILBOX_EMAIL
  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${emailId}/attachments`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  if (!r.ok) throw new Error(`List attachments: ${r.status}`)
  const atts = (await r.json()).value || []
  const pdf = atts.find(a => a.name?.endsWith('.pdf') || a.contentType === 'application/pdf')
  if (!pdf) throw new Error('No PDF found in email')

  const r2 = await fetch(`https://graph.microsoft.com/v1.0/users/${mailbox}/messages/${emailId}/attachments/${pdf.id}`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  const att = await r2.json()
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, Buffer.from(att.contentBytes, 'base64'))
  return pdf.name
}

// ── Ensure Supabase table exists ──────────────────────────────────────────────

let tableReady = false
async function ensureTable() {
  if (tableReady) return
  const sb = getSB()
  // Try inserting a test row to see if table exists
  const { error } = await sb.from('smartmail_leads').select('id').limit(1)
  if (error && error.code === '42P01') {
    // Table doesn't exist — create via a dummy upsert won't work, log warning
    console.warn('[smartmail] smartmail_leads table does not exist — run migration')
  }
  tableReady = true
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /api/smartmail/process-batch
router.post('/smartmail/process-batch', async (req, res) => {
  const { emailId, subject } = req.body
  if (!emailId) return res.status(400).json({ error: 'emailId required' })

  await ensureTable()
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const pdfPath = path.join(DATA_DIR, `${emailId.slice(-8).replace(/[^a-zA-Z0-9]/g,'_')}.pdf`)

  // Respond immediately — processing happens async
  res.json({ ok: true, batchId: emailId, status: 'processing', message: 'Processing started — check back in 30 seconds' })

  // Background processing
  setImmediate(async () => {
    try {
      const filename = await withRetry(() => downloadPdf(emailId, pdfPath))
      console.log(`[smartmail] Downloaded ${filename} (${(fs.statSync(pdfPath).size/1024).toFixed(0)}KB)`)

      const allLeads = await ocrPdfAllPages(pdfPath)
      console.log(`[smartmail] Extracted ${allLeads.length} leads`)

      const sb = getSB()
      let saved = 0

      for (let i = 0; i < allLeads.length; i++) {
        const lead = allLeads[i]
        if (!lead?.full_name) continue

        const v = await verify(lead, lead.printed_name, lead.printed_address)
        const rentcast = await getRentcastData(lead.address, lead.city, lead.state, lead.zip)

        const row = {
          batch_id: emailId,
          batch_subject: subject || filename,
          page_number: i + 1,
          full_name: lead.full_name,
          address: lead.address,
          city: lead.city,
          state: lead.state,
          zip: lead.zip,
          phone: lead.phone,
          email: lead.email,
          water_source: lead.water_source,
          buys_bottled_water: lead.buys_bottled_water,
          homeowner: lead.homeowner,
          water_conditions: Array.isArray(lead.water_conditions) ? lead.water_conditions.join(', ') : lead.water_conditions,
          water_quality: lead.water_quality,
          filtration: Array.isArray(lead.filtration) ? lead.filtration.join(', ') : lead.filtration,
          tds: lead.tds != null ? Number(lead.tds) : null,
          hd: lead.hd != null ? Number(lead.hd) : null,
          ph: lead.ph != null ? Number(lead.ph) : null,
          sample_date: lead.sample_date,
          printed_name: lead.printed_name,
          printed_address: lead.printed_address,
          name_match: v.name_match,
          addr_match: v.addr_match,
          phone_valid: v.phone_valid,
          email_valid: v.email_valid,
          area_code_match: v.area_code_match,
          brave_snippet: v.score,
          confidence: v.confidence,
          house_value: rentcast?.price || null,
          house_value_low: rentcast?.low || null,
          house_value_high: rentcast?.high || null,
          property_owner: rentcast?.owner || null,
          owner_occupied: rentcast?.ownerOccupied ?? null,
          last_sale_date: rentcast?.lastSaleDate || null,
          last_sale_price: rentcast?.lastSalePrice || null,
          sqft: rentcast?.sqft || null,
          beds: rentcast?.beds || null,
          baths: rentcast?.baths || null,
          year_built: rentcast?.yearBuilt || null,
          status: lead.homeowner === 'No' ? 'no_homeowner' : 'pending',
          ocr_raw: null,
        }

        const { error } = await sb.from('smartmail_leads').insert(row)
        if (error) console.error(`[smartmail] Insert error page ${i+1}:`, error.message)
        else saved++
      }

      console.log(`[smartmail] Done: ${saved}/${allLeads.length} leads saved`)
    } catch (err) {
      console.error('[smartmail] Background error:', err.message, err.stack?.slice(0, 300))
    }
  })
})


// GET /api/smartmail/batches
router.get('/smartmail/batches', async (req, res) => {
  try {
    const sb = getSB()
    const { data, error } = await sb
      .from('smartmail_leads')
      .select('batch_id, batch_subject, status, confidence, processed_at')
      .order('processed_at', { ascending: false })
    if (error) throw error
    // Group by batch
    const batches = {}
    for (const r of data || []) {
      if (!batches[r.batch_id]) batches[r.batch_id] = { batch_id: r.batch_id, subject: r.batch_subject, processed_at: r.processed_at, total: 0, pending: 0, approved: 0, rejected: 0, pushed: 0 }
      batches[r.batch_id].total++
      batches[r.batch_id][r.status] = (batches[r.batch_id][r.status] || 0) + 1
    }
    res.json(Object.values(batches))
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/smartmail/batch/:batchId
router.get('/smartmail/batch/:batchId', async (req, res) => {
  try {
    const sb = getSB()
    const { data, error } = await sb
      .from('smartmail_leads')
      .select('*')
      .eq('batch_id', req.params.batchId)
      .order('page_number')
    if (error) throw error
    res.json(data || [])
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/smartmail/approve/:id
router.post('/smartmail/approve/:id', async (req, res) => {
  const { error } = await getSB().from('smartmail_leads').update({ status: 'approved' }).eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

// POST /api/smartmail/reject/:id
router.post('/smartmail/reject/:id', async (req, res) => {
  const { error } = await getSB().from('smartmail_leads').update({ status: 'rejected' }).eq('id', req.params.id)
  if (error) return res.status(500).json({ error: error.message })
  res.json({ ok: true })
})

// POST /api/smartmail/push-to-sf/:batchId
router.post('/smartmail/push-to-sf/:batchId', async (req, res) => {
  try {
    const sb = getSB()
    const sfToken = await getSfToken()

    const { data: leads, error } = await sb
      .from('smartmail_leads')
      .select('*')
      .eq('batch_id', req.params.batchId)
      .eq('status', 'approved')
    if (error) throw error
    if (!leads?.length) return res.json({ ok: true, pushed: 0, message: 'No approved leads' })

    let pushed = 0, failed = 0
    const results = []

    for (const lead of leads) {
      const nameParts = (lead.full_name || '').trim().split(' ')
      const firstName = nameParts[0] || ''
      const lastName = nameParts.slice(1).join(' ') || firstName

      const fmt = p => {
        if (!p) return ''
        const d = p.replace(/\D/g,'')
        if (d.length === 10) return `(${d.slice(0,3)}) ${d.slice(3,6)}-${d.slice(6)}`
        return p
      }

      const notes = [
        `SmartMail Bottle Drop | Batch: ${lead.batch_subject}`,
        lead.property_owner    ? `Record Owner: ${lead.property_owner}` : null,
        lead.owner_occupied != null ? `Owner-Occupied: ${lead.owner_occupied ? 'Yes' : 'No'}` : null,
        lead.house_value       ? `Est. Value: $${Number(lead.house_value).toLocaleString()}` : null,

        lead.last_sale_price   ? `Last Sale: $${Number(lead.last_sale_price).toLocaleString()}${lead.last_sale_date ? ` (${lead.last_sale_date.slice(0,10)})` : ''}` : null,
        lead.sqft              ? `${lead.sqft.toLocaleString()} sqft` : null,
        lead.beds              ? `${lead.beds} bed` : null,
        lead.baths             ? `${lead.baths} bath` : null,
        lead.year_built        ? `Built ${lead.year_built}` : null,
      ].filter(Boolean).join(' | ')

      const record = {
        RecordTypeId: BOTTLE_DROP_RT,
        FirstName: firstName, LastName: lastName,
        LeadSource: 'BD',
        Lead_Source_Specific__c: 'SmartMail',
        Gift__c: 'No Gift',
        Phone: fmt(lead.phone),
        Email: lead.email || '',
        Status: 'New',
        Important_Details_Notes__c: notes,
        CountryCode: 'US',
      }

      // Address
      if (lead.address)   record.Street      = lead.address
      if (lead.city)      record.City         = lead.city
      if (lead.state)     record.StateCode    = lead.state
      if (lead.zip)       record.PostalCode   = lead.zip

      // Homeowner: only set Yes, never set No in SF
      if (lead.homeowner === 'Yes' || lead.homeowner === 'yes') {
        record.Homeowner__c = 'Yes'
      }
      // (if No, we flag in ops dashboard only — see status field)

      // Water data
      if (lead.water_source)     record.Water_Source__c      = lead.water_source
      if (lead.buys_bottled_water) record.Bottled_Water__c   = lead.buys_bottled_water
      if (lead.water_quality)    record.Rate_your_water__c   = lead.water_quality
      if (lead.water_conditions) record.Water_Conditions__c  = lead.water_conditions
      if (lead.filtration)       record.Water_Filters__c     = lead.filtration
      if (lead.hd  != null)      record.Hardness_Level__c    = lead.hd
      // TDS: add 100 to card value (per business rule)
      if (lead.tds != null)      record.TDS_Level__c         = lead.tds + 100
      if (lead.sample_date)      record.Bottle_Drop_Sample_Date__c = lead.sample_date
      if (lead.house_value)      record.House_Value__c              = lead.house_value

      const r = await fetch(`${SF_INSTANCE}/services/data/v59.0/sobjects/Lead`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${sfToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(record),
      })
      const result = await r.json()
      if (result.success) {
        await sb.from('smartmail_leads').update({ status: 'pushed', sf_lead_id: result.id }).eq('id', lead.id)
        results.push({ id: lead.id, sf_lead_id: result.id, name: lead.full_name })
        pushed++
      } else {
        console.warn('[smartmail] SF push failed:', lead.full_name, JSON.stringify(result).slice(0, 150))
        failed++
      }
    }

    res.json({ ok: true, pushed, failed, results })
  } catch (err) {
    console.error('[smartmail] push-to-sf error:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

// ── DEBUG: Test pipeline steps ────────────────────────────────────────────────
router.get('/smartmail/debug', async (req, res) => {
  const results = { anthropic_key: !!process.env.ANTHROPIC_API_KEY }
  
  // Test 1: Supabase write
  try {
    const sb = getSB()
    const { data, error } = await sb.from('smartmail_leads').insert({
      batch_id: 'DEBUG-' + Date.now(), batch_subject: 'debug', page_number: 1,
      full_name: 'Debug Test', status: 'pending'
    }).select('id').single()
    if (error) results.supabase = 'ERROR: ' + error.message
    else {
      results.supabase = 'OK id=' + data.id
      await sb.from('smartmail_leads').delete().eq('id', data.id)
    }
  } catch(e) { results.supabase = 'THROW: ' + e.message }
  
  // Test 2: Claude API
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5', max_tokens: 10, messages: [{role:'user',content:'say ok'}] })
    })
    const d = await r.json()
    results.claude = r.ok ? ('OK: ' + d.content?.[0]?.text) : ('ERROR ' + r.status + ': ' + JSON.stringify(d.error))
  } catch(e) { results.claude = 'THROW: ' + e.message }

  // Test 3: Graph token
  try {
    await getGraphToken()
    results.graph = 'OK'
  } catch(e) { results.graph = 'ERROR: ' + e.message }

  res.json(results)
})

export default router

