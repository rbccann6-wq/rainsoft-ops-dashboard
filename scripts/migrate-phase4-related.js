/**
 * Phase 4 — Quotes, Quote Line Items, Opportunity Line Items, Products
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

async function migrateObject({ token, instance, sfQuery, table, mapFn, label }) {
  console.log(`\n📦 Migrating ${label}...`)

  const countResp = await fetch(
    `${instance}/services/data/v59.0/query?q=${encodeURIComponent(sfQuery.replace(/SELECT.+FROM/, 'SELECT COUNT() FROM').split('ORDER')[0])}`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  const { totalSize } = await countResp.json()
  console.log(`   Total: ${totalSize.toLocaleString()}`)

  let url = `${instance}/services/data/v59.0/query?q=${encodeURIComponent(sfQuery)}`
  let migrated = 0, failed = 0

  while (url) {
    const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    const data = await resp.json()
    const mapped = (data.records || []).map(mapFn)

    for (let i = 0; i < mapped.length; i += 200) {
      const chunk = mapped.slice(i, i + 200)
      const { error } = await supabase.from(table).upsert(chunk, { onConflict: 'sf_id' })
      if (error) { failed += chunk.length; console.error('\n❌', error.message) }
      else migrated += chunk.length
    }

    process.stdout.write(`\r   Progress: ${migrated.toLocaleString()} / ${totalSize.toLocaleString()} (${((migrated/totalSize)*100).toFixed(1)}%)`)
    url = data.done ? null : `${instance}${data.nextRecordsUrl}`
    if (url) await new Promise(r => setTimeout(r, 100))
  }
  console.log(`\n   ✅ Done — ${migrated.toLocaleString()} migrated, ${failed} failed`)
  return { migrated, failed }
}

async function main() {
  console.log('🚀 Phase 4 — Quotes, Line Items, Products')
  console.log('==========================================')
  const token = await getSFSession()
  const instance = 'https://rainsoftse.my.salesforce.com'
  console.log('✅ Salesforce connected')

  await migrateObject({
    token, instance, table: 'sf_products', label: 'Products (392)',
    sfQuery: 'SELECT Id,Name,ProductCode,Description,IsActive,Family,CreatedDate FROM Product2 ORDER BY CreatedDate ASC',
    mapFn: r => ({ sf_id: r.Id, name: r.Name, product_code: r.ProductCode || null, description: r.Description || null, is_active: r.IsActive || false, family: r.Family || null, created_date: r.CreatedDate })
  })

  await migrateObject({
    token, instance, table: 'sf_quotes', label: 'Quotes (10,297)',
    sfQuery: 'SELECT Id,Name,OpportunityId,AccountId,ContactId,Status,QuoteNumber,GrandTotal,Subtotal,Discount_Amount__c,Total_Product_Cost__c,LineItemCount,IsSyncing,Email,OwnerId,CreatedDate,LastModifiedDate FROM Quote ORDER BY CreatedDate ASC',
    mapFn: r => ({ sf_id: r.Id, name: r.Name, opportunity_id: r.OpportunityId || null, account_id: r.AccountId || null, contact_id: r.ContactId || null, status: r.Status || null, quote_number: r.QuoteNumber || null, grand_total: r.GrandTotal || null, subtotal: r.Subtotal || null, discount_amount: r.Discount_Amount__c || null, total_product_cost: r.Total_Product_Cost__c || null, line_item_count: r.LineItemCount || null, is_syncing: r.IsSyncing || false, email: r.Email || null, owner_id: r.OwnerId || null, created_date: r.CreatedDate, last_modified_date: r.LastModifiedDate })
  })

  await migrateObject({
    token, instance, table: 'sf_quote_line_items', label: 'Quote Line Items (30,354)',
    sfQuery: 'SELECT Id,QuoteId,Product2Id,Product2.Name,Quantity,UnitPrice,TotalPrice,Discount,Description,CreatedDate FROM QuoteLineItem ORDER BY CreatedDate ASC',
    mapFn: r => ({ sf_id: r.Id, quote_id: r.QuoteId || null, product_id: r.Product2Id || null, product_name: r.Product2?.Name || null, quantity: r.Quantity || null, unit_price: r.UnitPrice || null, total_price: r.TotalPrice || null, discount: r.Discount || null, description: r.Description || null, created_date: r.CreatedDate })
  })

  await migrateObject({
    token, instance, table: 'sf_opportunity_line_items', label: 'Opportunity Line Items (29,286)',
    sfQuery: 'SELECT Id,OpportunityId,Product2Id,Product2.Name,Quantity,UnitPrice,TotalPrice,Description,CreatedDate FROM OpportunityLineItem ORDER BY CreatedDate ASC',
    mapFn: r => ({ sf_id: r.Id, opportunity_id: r.OpportunityId || null, product_id: r.Product2Id || null, product_name: r.Product2?.Name || null, quantity: r.Quantity || null, unit_price: r.UnitPrice || null, total_price: r.TotalPrice || null, description: r.Description || null, created_date: r.CreatedDate })
  })

  console.log('\n\n🎉 Phase 4 complete — all related objects migrated!')
}

main().catch(console.error)
