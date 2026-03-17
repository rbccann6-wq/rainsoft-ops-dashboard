/**
 * Phase 1 Migration — Salesforce Accounts → Supabase
 * Run locally: node scripts/migrate-phase1.js
 */

import { createClient } from '@supabase/supabase-js'
import 'dotenv/config'

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

function mapAccount(r) {
  return {
    sf_id: r.Id,
    customer_number: r.Customer_Number__c || null,
    first_name: r.FirstName || null,
    middle_name: r.MiddleName || null,
    last_name: r.LastName || null,
    full_name: r.Name || null,
    email: r.PersonEmail || null,
    phone: r.Phone || null,
    all_phones: r.ALL_PHONE__c || null,
    street: r.BillingStreet || r.PersonMailingStreet || null,
    city: r.BillingCity || r.PersonMailingCity || null,
    state: r.BillingState || r.PersonMailingState || null,
    zip: r.BillingPostalCode || r.PersonMailingPostalCode || null,
    country: r.BillingCountry || r.PersonMailingCountry || null,
    lat: r.PersonMailingLatitude || r.Mailing_Latitude__c || null,
    lng: r.PersonMailingLongitude || r.Mailing_Longitude__c || null,
    lead_source: r.PersonLeadSource || null,
    account_source: r.AccountSource || null,
    status: r.Status__pc || null,
    lead_status: r.Lead_Status__c || null,
    sales_rep: r.Sales_Rep__c || null,
    is_hd_deal: r.HD_DEAL__c || false,
    region: r.REGION__c || null,
    water_source: r.Water_Source__c || null,
    water_conditions: r.Water_Conditions__c || null,
    water_filters: r.Water_Filters__c || null,
    hardness_level: r.Hardness_Level__c || null,
    tds_level: r.TDS_Level__c || null,
    homeowner: r.Homeowner__c || null,
    type_of_home: r.Type_of_Home__c || null,
    house_value: r.House_Value__c || null,
    no_in_household: r.No_of_People_in_Household__c || null,
    bottled_water: r.Bottled_Water__c || null,
    mr_job: r.Mr_Job__c || null,
    mrs_job: r.Mrs_Job__c || null,
    kids_other: r.kids_Other_people_in_home__c || null,
    appointment_date: r.Appointment_Date__c || null,
    gift: r.Gift__c || null,
    install_pic: r.Install_Pic__c || null,
    created_date: r.CreatedDate || null,
    last_modified_date: r.LastModifiedDate || null,
    last_activity_date: r.LastActivityDate || null,
  }
}

async function main() {
  console.log('🚀 Phase 1 Migration — Salesforce Accounts → Supabase')
  console.log('=========================================================')

  // Get SF session
  console.log('🔐 Authenticating with Salesforce...')
  const token = await getSFSession()
  const instance = 'https://rainsoftse.my.salesforce.com'
  console.log('✅ Salesforce connected')

  // Get total count
  const countResp = await fetch(
    `${instance}/services/data/v59.0/query?q=SELECT+COUNT()+FROM+Account+WHERE+IsPersonAccount=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const { totalSize } = await countResp.json()
  console.log(`📊 Total accounts to migrate: ${totalSize.toLocaleString()}`)

  // Check existing
  const { count: existing } = await supabase.from('sf_accounts').select('*', { count: 'exact', head: true })
  if (existing > 0) {
    console.log(`⏭  Resuming — ${existing} already migrated, ${totalSize - existing} remaining`)
  }

  // Start migration
  const FIELDS = [
    'Id','Customer_Number__c','FirstName','MiddleName','LastName','Name',
    'PersonEmail','Phone','ALL_PHONE__c',
    'BillingStreet','BillingCity','BillingState','BillingPostalCode','BillingCountry',
    'PersonMailingStreet','PersonMailingCity','PersonMailingState','PersonMailingPostalCode','PersonMailingCountry',
    'PersonMailingLatitude','PersonMailingLongitude','Mailing_Latitude__c','Mailing_Longitude__c',
    'PersonLeadSource','AccountSource','Status__pc','Lead_Status__c','Sales_Rep__c','HD_DEAL__c','REGION__c',
    'Water_Source__c','Water_Conditions__c','Water_Filters__c','Hardness_Level__c','TDS_Level__c',
    'Homeowner__c','Type_of_Home__c','House_Value__c','No_of_People_in_Household__c','Bottled_Water__c',
    'Mr_Job__c','Mrs_Job__c','kids_Other_people_in_home__c','Appointment_Date__c','Gift__c','Install_Pic__c',
    'CreatedDate','LastModifiedDate','LastActivityDate'
  ].join(',')

  let url = `${instance}/services/data/v59.0/query?q=` +
    encodeURIComponent(`SELECT ${FIELDS} FROM Account WHERE IsPersonAccount=true ORDER BY CreatedDate ASC`)

  let migrated = existing || 0
  let failed = 0
  let batch = 0
  const CHUNK = 200 // upsert 200 at a time to Supabase

  while (url) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    const data = await resp.json()
    const records = data.records || []
    batch++

    // Map records
    const mapped = records.map(mapAccount)

    // Upsert to Supabase in chunks of 200
    for (let i = 0; i < mapped.length; i += CHUNK) {
      const chunk = mapped.slice(i, i + CHUNK)
      const { error } = await supabase.from('sf_accounts').upsert(chunk, { onConflict: 'sf_id' })
      if (error) {
        console.error(`❌ Batch ${batch} chunk error:`, error.message)
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

  console.log(`\n\n✅ Phase 1 Complete!`)
  console.log(`   Migrated: ${migrated.toLocaleString()}`)
  console.log(`   Failed:   ${failed}`)
  console.log(`   Check your Supabase dashboard to verify: ${SUPABASE_URL}`)
}

main().catch(console.error)
