/**
 * Phase 3 Migration — Salesforce Opportunities → Supabase
 */

import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  'https://njqavagyuwdmkeyoscbz.supabase.co',
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5qcWF2YWd5dXdkbWtleW9zY2J6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Mzc1NTM4MywiZXhwIjoyMDg5MzMxMzgzfQ.67pxlJAlqIKgTgDwpoDBcQZ12ezT3ZPbQRXsBnRptPs'
)

async function getSFSession() {
  const resp = await fetch('https://login.salesforce.com/services/Soap/u/59.0', {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=UTF-8', SOAPAction: 'login' },
    body: `<?xml version="1.0" encoding="utf-8"?><env:Envelope xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:env="http://schemas.xmlsoap.org/soap/envelope/"><env:Body><n1:login xmlns:n1="urn:partner.soap.sforce.com"><n1:username>rebecca@rainsoftse.com</n1:username><n1:password>06RAPPAR.!</n1:password></n1:login></env:Body></env:Envelope>`,
  })
  const text = await resp.text()
  const match = text.match(/<sessionId>([^<]+)<\/sessionId>/)
  if (!match) throw new Error('SF login failed')
  return match[1]
}

function mapOpportunity(r) {
  return {
    sf_id: r.Id,
    name: r.Name || null,
    account_id: r.AccountId || null,
    stage: r.StageName || null,
    status_reason: r.STATUS_REASON__c || null,
    close_date: r.CloseDate || null,
    created_date: r.CreatedDate || null,
    last_modified_date: r.LastModifiedDate || null,
    appt_number: r.Appt_Number__c ? String(r.Appt_Number__c) : null,
    appt_time: r.Appt_Time__c || null,
    day_of_week: r.Day_of_Week__c || null,
    street: r.Street__c || null,
    city: r.City__c || null,
    state: r.State__c || null,
    zip: r.Zip_Code__c || null,
    sales_rep: r.OwnerId || null,
    amount: r.Amount || null,
    probability: r.Probability || null,
    qrs_offered: r.QRS_OFFEREED__c || false,
    qrs_price: r.QRS_PRICE__c || null,
    ro_offered: r.RO_OFFERED__c || false,
    ro_price: r.RO_PRICE__c || null,
    ec5_offered: r.EC5_Offered__c || false,
    dispositioned: r.Dispositioned__c || false,
    fiscal_year: r.FiscalYear || null,
    fiscal_quarter: r.FiscalQuarter || null,
  }
}

async function main() {
  console.log('🚀 Phase 3 Migration — Salesforce Opportunities → Supabase')
  console.log('============================================================')

  console.log('🔐 Authenticating...')
  const token = await getSFSession()
  const instance = 'https://rainsoftse.my.salesforce.com'
  console.log('✅ Connected')

  const countResp = await fetch(
    `${instance}/services/data/v59.0/query?q=SELECT+COUNT()+FROM+Opportunity`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const { totalSize } = await countResp.json()
  console.log(`📊 Opportunities to migrate: ${totalSize.toLocaleString()}`)

  const { count: existing } = await supabase.from('sf_opportunities').select('*', { count: 'exact', head: true })
  if (existing > 0) console.log(`⏭  Resuming from ${existing}`)

  const FIELDS = 'Id,Name,AccountId,StageName,STATUS_REASON__c,CloseDate,CreatedDate,LastModifiedDate,Appt_Number__c,Appt_Time__c,Day_of_Week__c,Street__c,City__c,State__c,Zip_Code__c,OwnerId,Amount,Probability,QRS_OFFEREED__c,QRS_PRICE__c,RO_OFFERED__c,RO_PRICE__c,EC5_Offered__c,Dispositioned__c,FiscalYear,FiscalQuarter'

  let url = `${instance}/services/data/v59.0/query?q=` +
    encodeURIComponent(`SELECT ${FIELDS} FROM Opportunity ORDER BY CreatedDate ASC`)

  let migrated = existing || 0
  let failed = 0

  while (url) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    const data = await resp.json()
    const records = data.records || []
    const mapped = records.map(mapOpportunity)

    for (let i = 0; i < mapped.length; i += 200) {
      const chunk = mapped.slice(i, i + 200)
      const { error } = await supabase.from('sf_opportunities').upsert(chunk, { onConflict: 'sf_id' })
      if (error) { failed += chunk.length; console.error('\n❌', error.message) }
      else migrated += chunk.length
    }

    const pct = ((migrated / totalSize) * 100).toFixed(1)
    process.stdout.write(`\r📦 Progress: ${migrated.toLocaleString()} / ${totalSize.toLocaleString()} (${pct}%) — ${failed} failed`)

    url = data.done ? null : `${instance}${data.nextRecordsUrl}`
    if (url) await new Promise(r => setTimeout(r, 100))
  }

  console.log(`\n\n✅ Phase 3 Complete! ${migrated.toLocaleString()} opportunities, ${failed} failed`)
}

main().catch(console.error)
