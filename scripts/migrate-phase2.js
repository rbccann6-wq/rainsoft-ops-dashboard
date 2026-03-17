/**
 * Phase 2 Migration — Salesforce Open Leads → Supabase
 * Run locally: node scripts/migrate-phase2.js
 */

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://njqavagyuwdmkeyoscbz.supabase.co'
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5qcWF2YWd5dXdkbWtleW9zY2J6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Mzc1NTM4MywiZXhwIjoyMDg5MzMxMzgzfQ.67pxlJAlqIKgTgDwpoDBcQZ12ezT3ZPbQRXsBnRptPs'

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

async function getSFSession() {
  const resp = await fetch('https://login.salesforce.com/services/Soap/u/59.0', {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: 'login' },
    body: `<?xml version="1.0" encoding="utf-8"?>
<env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:env="http://schemas.xmlsoap.org/soap/envelope/">
  <env:Body>
    <n1:login xmlns:n1="urn:partner.soap.sforce.com">
      <n1:username>rebecca@rainsoftse.com</n1:username>
      <n1:password>06RAPPAR.!</n1:password>
    </n1:login>
  </env:Body>
</env:Envelope>`,
  })
  const text = await resp.text()
  const match = text.match(/<sessionId>([^<]+)<\/sessionId>/)
  if (!match) throw new Error('SF login failed')
  return match[1]
}

function mapLead(r) {
  return {
    sf_id: r.Id,
    first_name: r.FirstName || null,
    last_name: r.LastName || null,
    full_name: [r.FirstName, r.LastName].filter(Boolean).join(' ') || r.Company || null,
    email: r.Email || null,
    phone: r.Phone || null,
    mobile: r.MobilePhone || null,
    street: r.Street || null,
    city: r.City || null,
    state: r.State || null,
    zip: r.PostalCode || null,
    country: r.Country || null,
    lead_source: r.LeadSource || null,
    status: r.Status || null,
    sales_rep: r.OwnerId || null,
    is_converted: r.IsConverted || false,
    converted_account_id: r.ConvertedAccountId || null,
    description: r.Description || null,
    created_date: r.CreatedDate || null,
    last_modified_date: r.LastModifiedDate || null,
  }
}

async function main() {
  console.log('🚀 Phase 2 Migration — Salesforce Leads → Supabase')
  console.log('====================================================')

  console.log('🔐 Authenticating with Salesforce...')
  const token = await getSFSession()
  const instance = 'https://rainsoftse.my.salesforce.com'
  console.log('✅ Salesforce connected')

  // Count open leads only
  const countResp = await fetch(
    `${instance}/services/data/v59.0/query?q=SELECT+COUNT()+FROM+Lead+WHERE+IsConverted=false`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const { totalSize } = await countResp.json()
  console.log(`📊 Open leads to migrate: ${totalSize.toLocaleString()}`)

  // Check existing
  const { count: existing } = await supabase.from('sf_leads').select('*', { count: 'exact', head: true })
  if (existing > 0) {
    console.log(`⏭  Resuming — ${existing} already migrated`)
  }

  const FIELDS = [
    'Id','FirstName','LastName','Company','Email','Phone','MobilePhone',
    'Street','City','State','PostalCode','Country',
    'LeadSource','Status','OwnerId','IsConverted','ConvertedAccountId',
    'Description','CreatedDate','LastModifiedDate'
  ].join(',')

  let url = `${instance}/services/data/v59.0/query?q=` +
    encodeURIComponent(`SELECT ${FIELDS} FROM Lead WHERE IsConverted=false ORDER BY CreatedDate ASC`)

  let migrated = existing || 0
  let failed = 0
  let batch = 0

  while (url) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    const data = await resp.json()
    const records = data.records || []
    batch++

    const mapped = records.map(mapLead)

    // Upsert in chunks of 200
    for (let i = 0; i < mapped.length; i += 200) {
      const chunk = mapped.slice(i, i + 200)
      const { error } = await supabase.from('sf_leads').upsert(chunk, { onConflict: 'sf_id' })
      if (error) {
        console.error(`❌ Batch ${batch} error:`, error.message)
        failed += chunk.length
      } else {
        migrated += chunk.length
      }
    }

    const pct = ((migrated / totalSize) * 100).toFixed(1)
    process.stdout.write(`\r📦 Progress: ${migrated.toLocaleString()} / ${totalSize.toLocaleString()} (${pct}%) — ${failed} failed`)

    url = data.done ? null : `${instance}${data.nextRecordsUrl}`
    if (url) await new Promise(r => setTimeout(r, 100))
  }

  console.log(`\n\n✅ Phase 2 Complete!`)
  console.log(`   Migrated: ${migrated.toLocaleString()} leads`)
  console.log(`   Failed:   ${failed}`)
}

main().catch(console.error)
