/**
 * SmartMail Bottle Drop Lead Processing
 * Downloads PDFs → Claude vision OCR → verification → Salesforce push
 */

import express from 'express'
import { execSync } from 'child_process'
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
const BRAVE_KEY = 'BSA3VL7tgNknVMsSkZM7Qjhz9Qj0nIq'

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

function pdfToImages(pdfPath, outDir) {
  fs.mkdirSync(outDir, { recursive: true })
  const script = `
import pdfplumber, sys, os
pdf_path = sys.argv[1]
out_dir = sys.argv[2]
with pdfplumber.open(pdf_path) as pdf:
    for i, page in enumerate(pdf.pages):
        img = page.to_image(resolution=150)
        img.save(os.path.join(out_dir, f'page_{i+1}.png'))
    print(len(pdf.pages))
`
  const tmpScript = '/tmp/pdf2img.py'
  fs.writeFileSync(tmpScript, script)
  const count = execSync(`python3 ${tmpScript} "${pdfPath}" "${outDir}"`, { timeout: 60000 }).toString().trim()
  return parseInt(count) || 0
}

// ── Claude vision OCR ─────────────────────────────────────────────────────────

async function ocrPage(imagePath) {
  const imgData = fs.readFileSync(imagePath).toString('base64')
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-5',
      max_tokens: 1024,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: imgData } },
          { type: 'text', text: 'Extract all data from this water test lead card. Return ONLY valid JSON with these exact fields: full_name (handwritten name), address (handwritten street address only), city (string), state (2-letter code), zip (string), phone (string), email (string), water_source ("City" or "Well"), buys_bottled_water ("Yes" or "No"), water_conditions (array from: Chlorine Smell, Brown Stains, Scale Deposits, Rotten Smell, Cloudiness), water_quality ("Good" or "Fair" or "Poor"), filtration (array from: Refrigerator, Whole Home, Sink, None), tds (number or null), hd (number or null), ph (number or null), printed_name (the PRINTED/TYPED name from the mailing label at top), printed_address (the PRINTED/TYPED street address from mailing label). If a field is blank or unclear use null. Return ONLY the JSON object, no explanation.' }
        ]
      }]
    })
  })
  if (!r.ok) throw new Error(`Claude API ${r.status}`)
  const d = await r.json()
  const text = d.content?.[0]?.text || ''
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('No JSON in Claude response')
  return { parsed: JSON.parse(jsonMatch[0]), raw: text }
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

  const pdfPath = path.join(DATA_DIR, `${emailId.slice(-8)}.pdf`)
  const imgDir  = path.join(DATA_DIR, `${emailId.slice(-8)}_pages`)

  // Stream progress via SSE or just process and return
  res.setHeader('Content-Type', 'application/json')

  try {
    // Download PDF
    const filename = await withRetry(() => downloadPdf(emailId, pdfPath))
    console.log(`[smartmail] Downloaded ${filename}`)

    // Convert to images
    const pageCount = pdfToImages(pdfPath, imgDir)
    console.log(`[smartmail] Converted ${pageCount} pages`)

    const sb = getSB()
    const results = []

    for (let i = 1; i <= pageCount; i++) {
      const imgPath = path.join(imgDir, `page_${i}.png`)
      if (!fs.existsSync(imgPath)) continue

      let lead = null, raw = ''
      try {
        const ocr = await ocrPage(imgPath)
        lead = ocr.parsed; raw = ocr.raw
      } catch (err) {
        console.error(`[smartmail] OCR failed page ${i}:`, err.message)
        continue
      }

      if (!lead?.full_name) continue  // skip blank/envelope pages

      // Verify: card cross-check + area code + email DNS
      const v = await verify(lead, lead.printed_name, lead.printed_address)
      const conf = v.confidence

      const row = {
        batch_id: emailId,
        batch_subject: subject || filename,
        page_number: i,
        full_name: lead.full_name,
        address: lead.address,
        city: lead.city,
        state: lead.state,
        zip: lead.zip,
        phone: lead.phone,
        email: lead.email,
        water_source: lead.water_source,
        buys_bottled_water: lead.buys_bottled_water,
        water_conditions: lead.water_conditions?.join(', ') || null,
        water_quality: lead.water_quality,
        filtration: lead.filtration?.join(', ') || null,
        tds: lead.tds,
        hd: lead.hd,
        ph: lead.ph,
        name_match: v.name_match,
        addr_match: v.addr_match,
        phone_valid: v.phone_valid,
        email_valid: v.email_valid,
        area_code_match: v.area_code_match,
        brave_snippet: v.score,
        confidence: conf,
        printed_name: lead.printed_name || null,
        printed_address: lead.printed_address || null,
        status: 'pending',
        ocr_raw: raw,
      }

      const { data, error } = await sb.from('smartmail_leads').insert(row).select('id').single()
      if (error) console.error('[smartmail] DB insert error:', error.message)
      else results.push({ ...row, id: data.id })
    }

    // Cleanup images (keep PDF for reprocessing)
    try { fs.rmSync(imgDir, { recursive: true }) } catch {}

    res.json({ ok: true, batchId: emailId, total: results.length, leads: results })
  } catch (err) {
    console.error('[smartmail] process-batch error:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
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
        lead.tds != null ? `TDS=${lead.tds}` : null,
        lead.hd  != null ? `HD=${lead.hd}`   : null,
        lead.ph  != null ? `PH=${lead.ph}`   : null,
        lead.water_source   ? `Source: ${lead.water_source}` : null,
        lead.water_quality  ? `Quality: ${lead.water_quality}` : null,
        lead.water_conditions ? `Conditions: ${lead.water_conditions}` : null,
      ].filter(Boolean).join(' | ')

      const record = {
        RecordTypeId: BOTTLE_DROP_RT,
        FirstName: firstName, LastName: lastName,
        LeadSource: 'BD',
        Phone: fmt(lead.phone),
        Email: lead.email || '',
        Status: 'New',
        Important_Details_Notes__c: notes,
        CountryCode: 'US',
      }
      if (lead.address)   record.Street     = lead.address
      if (lead.city)      record.City        = lead.city
      if (lead.state)     record.StateCode   = lead.state
      if (lead.zip)       record.PostalCode  = lead.zip

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

export default router
