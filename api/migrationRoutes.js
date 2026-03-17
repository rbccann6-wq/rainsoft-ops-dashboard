/**
 * Salesforce Migration Routes
 * Phase 1: Person Accounts (customers)
 * Runs in background, resumable, never re-imports duplicates.
 * Completely free — uses Salesforce API + PostgreSQL.
 */

import express from 'express'
import { createClient } from '@supabase/supabase-js'

const router = express.Router()

function getSupabase() {
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY not set')
  return createClient(url, key)
}

async function withRetry(fn, label, max = 3) {
  let lastErr
  for (let i = 1; i <= max; i++) {
    try { return await fn() } catch (err) {
      lastErr = err
      if (i < max) await new Promise(r => setTimeout(r, 1000 * i))
    }
  }
  throw new Error(`[${label}] failed after ${max} attempts: ${lastErr.message}`)
}

// ─── Salesforce auth (SOAP login, no token needed) ───────────────────────────

async function getSalesforceSession() {
  const resp = await fetch('https://login.salesforce.com/services/Soap/u/59.0', {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: 'login' },
    body: `<?xml version="1.0" encoding="utf-8"?>
<env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
  <env:Body>
    <n1:login xmlns:n1="urn:partner.soap.sforce.com">
      <n1:username>${process.env.SF_USERNAME || 'rebecca@rainsoftse.com'}</n1:username>
      <n1:password>${process.env.SF_PASSWORD || '06RAPPAR.!'}</n1:password>
    </n1:login>
  </env:Body>
</env:Envelope>`,
  })
  const text = await resp.text()
  const sessionMatch = text.match(/<sessionId>([^<]+)<\/sessionId>/)
  if (!sessionMatch) throw new Error('Salesforce login failed')
  return { token: sessionMatch[1], instance: 'https://rainsoftse.my.salesforce.com' }
}

// ─── Migration state (in-memory progress tracker) ────────────────────────────

let migrationState = {
  status: 'idle',
  phase: null,
  migrated: 0,
  failed: 0,
  total: 0,
  currentBatch: 0,
  lastSfId: null,
  startedAt: null,
  errors: [],
}

// ─── Map SF account to DB row ─────────────────────────────────────────────────

function mapAccount(r) {
  return {
    sf_id: r.Id,
    customer_number: r.Customer_Number__c,
    first_name: r.FirstName,
    middle_name: r.MiddleName,
    last_name: r.LastName,
    full_name: r.Name,
    email: r.PersonEmail,
    phone: r.Phone,
    all_phones: r.ALL_PHONE__c,
    street: r.BillingStreet || r.PersonMailingStreet,
    city: r.BillingCity || r.PersonMailingCity,
    state: r.BillingState || r.PersonMailingState,
    zip: r.BillingPostalCode || r.PersonMailingPostalCode,
    country: r.BillingCountry || r.PersonMailingCountry,
    lat: r.PersonMailingLatitude || r.Mailing_Latitude__c,
    lng: r.PersonMailingLongitude || r.Mailing_Longitude__c,
    lead_source: r.PersonLeadSource,
    account_source: r.AccountSource,
    status: r.Status__pc,
    lead_status: r.Lead_Status__c,
    sales_rep: r.Sales_Rep__c,
    is_hd_deal: r.HD_DEAL__c || false,
    region: r.REGION__c,
    water_source: r.Water_Source__c,
    water_conditions: r.Water_Conditions__c,
    water_filters: r.Water_Filters__c,
    hardness_level: r.Hardness_Level__c,
    tds_level: r.TDS_Level__c,
    homeowner: r.Homeowner__c,
    type_of_home: r.Type_of_Home__c,
    house_value: r.House_Value__c,
    no_in_household: r.No_of_People_in_Household__c,
    bottled_water: r.Bottled_Water__c,
    mr_job: r.Mr_Job__c,
    mrs_job: r.Mrs_Job__c,
    kids_other: r.kids_Other_people_in_home__c,
    appointment_date: r.Appointment_Date__c || null,
    gift: r.Gift__c,
    install_pic: r.Install_Pic__c,
    created_date: r.CreatedDate,
    last_modified_date: r.LastModifiedDate,
    last_activity_date: r.LastActivityDate || null,
  }
}

// ─── Background migration runner ──────────────────────────────────────────────

async function runPhase1Migration(force = false) {
  if (migrationState.status === 'running') return

  migrationState = {
    status: 'running',
    phase: 'phase1_accounts',
    migrated: 0,
    failed: 0,
    total: 0,
    currentBatch: 0,
    lastSfId: null,
    startedAt: new Date().toISOString(),
    errors: [],
  }

  const supabase = getSupabase()

  try {
    // Log start
    await supabase.from('migration_log').upsert({
      phase: 'phase1', object_type: 'Account', status: 'running', started_at: new Date().toISOString()
    }, { onConflict: 'phase,object_type' })

    const { token, instance } = await getSalesforceSession()

    // Get total count
    const countResp = await fetch(
      `${instance}/services/data/v59.0/query?q=SELECT+COUNT()+FROM+Account+WHERE+IsPersonAccount=true`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    const countData = await countResp.json()
    migrationState.total = countData.totalSize || 0

    console.log(`[Migration] Phase 1: ${migrationState.total} accounts to migrate`)

    // Check if we have existing data (for resume)
    const { count: alreadyMigrated } = await supabase
      .from('sf_accounts').select('*', { count: 'exact', head: true })
    const existing = alreadyMigrated || 0

    if (existing > 0 && !force) {
      console.log(`[Migration] Resuming from ${existing} already migrated`)
      migrationState.migrated = existing
    }

    // Paginate through all accounts
    const BATCH_SIZE = 200
    let queryUrl = `${instance}/services/data/v59.0/query?q=` +
      encodeURIComponent(
        `SELECT Id,Customer_Number__c,FirstName,MiddleName,LastName,Name,PersonEmail,Phone,` +
        `ALL_PHONE__c,BillingStreet,BillingCity,BillingState,BillingPostalCode,BillingCountry,` +
        `PersonMailingStreet,PersonMailingCity,PersonMailingState,PersonMailingPostalCode,PersonMailingCountry,` +
        `PersonMailingLatitude,PersonMailingLongitude,Mailing_Latitude__c,Mailing_Longitude__c,` +
        `PersonLeadSource,AccountSource,Status__pc,Lead_Status__c,Sales_Rep__c,HD_DEAL__c,REGION__c,` +
        `Water_Source__c,Water_Conditions__c,Water_Filters__c,Hardness_Level__c,TDS_Level__c,` +
        `Homeowner__c,Type_of_Home__c,House_Value__c,No_of_People_in_Household__c,Bottled_Water__c,` +
        `Mr_Job__c,Mrs_Job__c,kids_Other_people_in_home__c,Appointment_Date__c,Gift__c,Install_Pic__c,` +
        `CreatedDate,LastModifiedDate,LastActivityDate ` +
        `FROM Account WHERE IsPersonAccount=true ORDER BY CreatedDate ASC`
      )

    let done = false
    while (!done) {
      const resp = await withRetry(async () => {
        const r = await fetch(queryUrl, { headers: { Authorization: `Bearer ${token}` } })
        if (!r.ok) throw new Error(`SF query ${r.status}`)
        return r.json()
      }, 'sf-query-batch')

      const records = resp.records || []
      migrationState.currentBatch++

      // Upsert each record
      for (const record of records) {
        try {
          const mapped = mapAccount(record)
          const cols = Object.keys(mapped)
          const vals = Object.values(mapped)
          const placeholders = vals.map((_, i) => `$${i + 1}`)
          const updates = cols.filter(c => c !== 'sf_id').map(c => `${c} = EXCLUDED.${c}`)

          const { error: upsertErr } = await supabase
            .from('sf_accounts')
            .upsert(mapped, { onConflict: 'sf_id' })
          if (upsertErr) throw new Error(upsertErr.message)
          migrationState.migrated++
          migrationState.lastSfId = record.Id
        } catch (err) {
          migrationState.failed++
          migrationState.errors.push(`${record.Id}: ${err.message}`)
          console.error(`[Migration] Failed record ${record.Id}:`, err.message)
        }
      }

      console.log(`[Migration] Batch ${migrationState.currentBatch}: ${migrationState.migrated}/${migrationState.total}`)

      if (resp.done || !resp.nextRecordsUrl) {
        done = true
      } else {
        queryUrl = `${instance}${resp.nextRecordsUrl}`
        await new Promise(r => setTimeout(r, 100)) // brief pause
      }
    }

    migrationState.status = 'done'
    await supabase.from('migration_log').update({
      status: 'done',
      migrated: migrationState.migrated,
      failed: migrationState.failed,
      finished_at: new Date().toISOString()
    }).eq('phase', 'phase1').eq('object_type', 'Account')

    console.log(`[Migration] Phase 1 complete: ${migrationState.migrated} migrated, ${migrationState.failed} failed`)

  } catch (err) {
    migrationState.status = 'error'
    migrationState.errors.push(err.message)
    console.error('[Migration] Phase 1 error:', err.message)
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// POST /api/migration/start — kick off phase 1
router.post('/migration/start', (req, res) => {
  const force = req.body?.force === true
  if (migrationState.status === 'running') {
    return res.json({ message: 'Already running', state: migrationState })
  }
  runPhase1Migration(force) // fire and forget
  res.json({ started: true, message: 'Phase 1 migration started in background' })
})

// GET /api/migration/status — poll progress
router.get('/migration/status', (req, res) => {
  const pct = migrationState.total > 0
    ? Math.round((migrationState.migrated / migrationState.total) * 100)
    : 0
  res.json({ ...migrationState, percentComplete: pct })
})

// GET /api/migration/accounts — query migrated accounts
router.get('/migration/accounts', async (req, res) => {
  try {
    const supabase = getSupabase()
    const { search, limit = 50, offset = 0 } = req.query
    let query = supabase.from('sf_accounts').select('*', { count: 'exact' })
    if (search) {
      query = query.or(`full_name.ilike.%${search}%,phone.ilike.%${search}%,email.ilike.%${search}%`)
    }
    const { data, count, error } = await query
      .order('last_name').order('first_name')
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1)
    if (error) throw new Error(error.message)
    res.json({ accounts: data, total: count })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router
