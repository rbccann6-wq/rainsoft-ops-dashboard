/**
 * Deal Tracker Routes — Finance portal deal status monitoring
 * Reads from PostgreSQL finance_monitor_deals + finance_monitor_history tables
 */
import express from 'express'
import { getDb } from './db/index.js'

const router = express.Router()

/** Convert snake_case PG row to camelCase for frontend */
function toCamel(row) {
  if (!row) return row
  return {
    dealId: row.deal_id,
    portal: row.portal,
    customerName: row.customer_name,
    coapplicant: row.coapplicant,
    submittedDate: row.submitted_date,
    assignedUser: row.assigned_user,
    decision: row.decision,
    discount: row.discount != null ? parseFloat(row.discount) : null,
    fundingRequirements: row.funding_requirements,
    status: row.status,
    lastStatus: row.last_status,
    statusChangedAt: row.status_changed_at,
    docsRequestedAt: row.docs_requested_at,
    lastCheckedAt: row.last_checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    saleAmount: row.sale_amount != null ? parseFloat(row.sale_amount) : null,
    dealSource: row.deal_source,
    salesRep: row.sales_rep,
    financeAmount: row.finance_amount != null ? parseFloat(row.finance_amount) : null,
    buyRate: row.buy_rate != null ? parseFloat(row.buy_rate) : null,
    tier: row.tier,
    referenceNumber: row.reference_number,
    optionCode: row.option_code,
    saleDate: row.sale_date,
    dealNotes: row.deal_notes,
    expDate: row.exp_date,
    fundingDate: row.funding_date,
    rescindDate: row.rescind_date,
    state: row.state,
    address: row.address,
    phone: row.phone,
    city: row.city,
    zip: row.zip,
    email: row.email,
    isMultiSubmit: row.isMultiSubmit || false,
  }
}

function historyCamel(row) {
  return {
    id: row.id,
    dealId: row.deal_id,
    portal: row.portal,
    oldStatus: row.old_status,
    newStatus: row.new_status,
    changedAt: row.changed_at,
  }
}

// ── GET /api/deal-tracker/deals ─────────────────────────────────────────────
router.get('/deal-tracker/deals', async (req, res) => {
  try {
    const db = getDb()
    const { portal, status, search, page = 1, limit = 50, grouped = 'false' } = req.query
    const offset = (parseInt(page) - 1) * parseInt(limit)

    let where = []
    let params = []
    let paramIdx = 1

    if (portal) {
      where.push(`fm.portal = $${paramIdx++}`)
      params.push(portal.toLowerCase())
    }
    if (status) {
      where.push(`fm.status = $${paramIdx++}`)
      params.push(status)
    }
    if (search) {
      where.push(`LOWER(fm.customer_name) LIKE $${paramIdx++}`)
      params.push(`%${search.toLowerCase()}%`)
    }

    const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''

    // Get deals
    const query = `
      SELECT fm.*
      FROM finance_monitor_deals fm
      ${whereClause}
      ORDER BY
        CASE WHEN fm.submitted_date IS NULL OR fm.submitted_date = '' THEN 0 ELSE 1 END DESC,
        CASE WHEN fm.submitted_date ~ '^[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}$'
          THEN TO_DATE(fm.submitted_date, 'MM/DD/YYYY')
          ELSE '1970-01-01'::date END DESC,
        fm.customer_name ASC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `
    params.push(parseInt(limit), offset)

    const { rows } = await db.query(query, params)

    // Get total count
    const countQuery = `SELECT COUNT(*) FROM finance_monitor_deals fm ${whereClause}`
    const countParams = params.slice(0, params.length - 2)
    const { rows: countRows } = await db.query(countQuery, countParams)

    // Convert rows to camelCase
    const enriched = rows.map(row => toCamel(row))

    // GROUP BY CUSTOMER — each customer shows all portals they were submitted to
    if (grouped === 'true') {
      const customerMap = {}
      for (const deal of enriched) {
        const key = deal.customerName || 'Unknown'
        if (!customerMap[key]) {
          customerMap[key] = {
            customerName: deal.customerName,
            address: deal.address,
            state: deal.state,
            submittedDate: deal.submittedDate,
            portals: [],
            isMultiSubmit: false,
          }
        }
        customerMap[key].portals.push({
          portal: deal.portal,
          status: deal.status,
          decision: deal.decision,
          dealId: deal.dealId,
          financeAmount: deal.financeAmount,
          buyRate: deal.buyRate,
          tier: deal.tier,
          referenceNumber: deal.referenceNumber,
          fundingDate: deal.fundingDate,
          lastCheckedAt: deal.lastCheckedAt,
          updatedAt: deal.updatedAt,
        })
        if (customerMap[key].portals.length > 1) {
          customerMap[key].isMultiSubmit = true
        }
      }
      const grouped_customers = Object.values(customerMap).sort((a, b) =>
        (a.customerName || '').localeCompare(b.customerName || '')
      )
      return res.json({
        customers: grouped_customers,
        total: grouped_customers.length,
        dealsTotal: parseInt(countRows[0].count),
      })
    }

    const totalCount = parseInt(countRows[0].count)
    const pageInt = parseInt(page)
    const limitInt = parseInt(limit)

    res.json({
      deals: enriched,
      total: totalCount,
      page: pageInt,
      limit: limitInt,
      pagination: {
        page: pageInt,
        limit: limitInt,
        total: totalCount,
        pages: Math.ceil(totalCount / limitInt),
      },
    })
  } catch (err) {
    console.error('[DealTracker] GET /deals error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/deal-tracker/comparison ────────────────────────────────────────
router.get('/deal-tracker/comparison', async (req, res) => {
  try {
    const db = getDb()

    // Find customers with deals in multiple portals
    const { rows } = await db.query(`
      SELECT customer_name, portal, decision, discount, status, deal_id, submitted_date,
             status_changed_at, docs_requested_at
      FROM finance_monitor_deals
      WHERE customer_name IN (
        SELECT customer_name FROM finance_monitor_deals
        GROUP BY customer_name HAVING COUNT(DISTINCT portal) > 1
      )
      ORDER BY customer_name, portal
    `)

    // Group by customer
    const grouped = {}
    for (const row of rows) {
      if (!grouped[row.customer_name]) grouped[row.customer_name] = []
      grouped[row.customer_name].push(row)
    }

    // Find best rate per customer (lowest lender discount = highest dealer keep)
    const comparisons = Object.entries(grouped).map(([name, deals]) => {
      const approved = deals.filter(d => d.decision === 'Approved' && d.discount != null)
      let bestDealId = null
      if (approved.length > 0) {
        const best = approved.reduce((a, b) => (parseFloat(a.discount) < parseFloat(b.discount) ? a : b))
        bestDealId = best.deal_id
      }
      return {
        customerName: name,
        portalCount: new Set(deals.map(d => d.portal)).size,
        deals: deals.map(d => {
          const camel = toCamel(d)
          camel.isBestRate = d.deal_id === bestDealId
          return camel
        }),
      }
    })

    res.json({ comparisons })
  } catch (err) {
    console.error('[DealTracker] GET /comparison error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/deal-tracker/stats ─────────────────────────────────────────────
router.get('/deal-tracker/stats', async (req, res) => {
  try {
    const db = getDb()

    const [
      { rows: totalRows },
      { rows: portalRows },
      { rows: statusRows },
      { rows: activeRows },
      { rows: awaitingRows },
      { rows: staleRows },
      { rows: fundedRows },
      { rows: multiRows },
      { rows: avgDiscountRows },
    ] = await Promise.all([
      db.query(`SELECT COUNT(*) FROM finance_monitor_deals`),
      db.query(`SELECT portal, COUNT(*) as count FROM finance_monitor_deals GROUP BY portal`),
      db.query(`SELECT status, COUNT(*) as count FROM finance_monitor_deals GROUP BY status ORDER BY count DESC`),
      db.query(`SELECT COUNT(*) FROM finance_monitor_deals WHERE status NOT IN ('Funded', 'Declined')`),
      db.query(`
        SELECT COUNT(*) as count, 
               MIN(docs_requested_at) as oldest
        FROM finance_monitor_deals WHERE status = 'Awaiting Docs'
      `),
      db.query(`
        SELECT COUNT(*) FROM finance_monitor_deals 
        WHERE status = 'Awaiting Docs' 
          AND docs_requested_at IS NOT NULL 
          AND docs_requested_at < NOW() - INTERVAL '12 hours'
      `),
      db.query(`
        SELECT COUNT(*) FROM finance_monitor_deals 
        WHERE status = 'Funded' 
          AND status_changed_at >= date_trunc('month', CURRENT_DATE)
      `),
      db.query(`
        SELECT COUNT(DISTINCT customer_name) FROM (
          SELECT customer_name FROM finance_monitor_deals
          GROUP BY customer_name HAVING COUNT(DISTINCT portal) > 1
        ) sub
      `),
      db.query(`
        SELECT portal, ROUND(AVG(discount), 2) as avg_discount 
        FROM finance_monitor_deals 
        WHERE discount IS NOT NULL AND decision = 'Approved'
        GROUP BY portal
      `),
    ])

    // Calculate oldest awaiting docs age
    let oldestAwaitingHours = null
    if (awaitingRows[0]?.oldest) {
      oldestAwaitingHours = Math.round((Date.now() - new Date(awaitingRows[0].oldest).getTime()) / 3600000)
    }

    res.json({
      total: parseInt(totalRows[0].count),
      byPortal: Object.fromEntries(portalRows.map(r => [r.portal, parseInt(r.count)])),
      byStatus: statusRows.map(r => ({ status: r.status, count: parseInt(r.count) })),
      active: parseInt(activeRows[0].count),
      awaitingDocs: parseInt(awaitingRows[0].count),
      oldestAwaitingHours,
      staleDocs: parseInt(staleRows[0].count),
      fundedThisMonth: parseInt(fundedRows[0].count),
      multiSubmit: parseInt(multiRows[0].count),
      avgDiscountByPortal: Object.fromEntries(avgDiscountRows.map(r => [r.portal, parseFloat(r.avg_discount)])),
    })
  } catch (err) {
    console.error('[DealTracker] GET /stats error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/deal-tracker/history/:dealId ────────────────────────────────────
router.get('/deal-tracker/history/:dealId', async (req, res) => {
  try {
    const db = getDb()
    const { dealId } = req.params
    const portal = req.query.portal || 'ispc'

    const [dealResult, historyResult] = await Promise.all([
      db.query(
        'SELECT * FROM finance_monitor_deals WHERE deal_id = $1 AND portal = $2',
        [dealId, portal]
      ),
      db.query(
        'SELECT * FROM finance_monitor_history WHERE deal_id = $1 AND portal = $2 ORDER BY changed_at DESC',
        [dealId, portal]
      ),
    ])

    if (dealResult.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found' })
    }

    // Also get comparison deals for same customer
    const deal = dealResult.rows[0]
    const { rows: relatedDeals } = await db.query(
      'SELECT * FROM finance_monitor_deals WHERE customer_name = $1 AND NOT (deal_id = $2 AND portal = $3)',
      [deal.customer_name, dealId, portal]
    )

    res.json({
      deal: toCamel(deal),
      history: historyResult.rows.map(historyCamel),
      relatedDeals: relatedDeals.map(toCamel),
    })
  } catch (err) {
    console.error('[DealTracker] GET /history error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── POST /api/deal-tracker/sync ─────────────────────────────────────────────
// Called by the finance monitor agent to push deal updates
router.post('/deal-tracker/sync', async (req, res) => {
  try {
    const db = getDb()
    const { deals, portal } = req.body

    if (!deals || !Array.isArray(deals) || !portal) {
      return res.status(400).json({ error: 'Required: { deals: [...], portal: "ispc" }' })
    }

    let newCount = 0
    let changedCount = 0
    const alerts = []

    for (const deal of deals) {
      // Check existing by deal_id + portal (primary key)
      const { rows: existing } = await db.query(
        'SELECT deal_id, status, docs_requested_at FROM finance_monitor_deals WHERE deal_id = $1 AND portal = $2',
        [deal.dealId, portal]
      )

      // Also check for same customer + portal with a different deal_id (ISPC reassigns IDs)
      // Use fuzzy name matching: last name + first initial, to handle abbreviated vs full names
      // e.g., "HAWK, C" should match "HAWK, CHRISTOPHER"
      if (existing.length === 0 && deal.customerName) {
        // Parse last name and first initial from the incoming deal name
        const nameParts = deal.customerName.trim().toUpperCase().match(/^([A-Z'-]+)\s*,\s*(.+)$/)
        const lastName = nameParts ? nameParts[1] : deal.customerName.trim().toUpperCase().split(/\s+/).pop()
        const firstInitial = nameParts ? nameParts[2].trim()[0] : deal.customerName.trim().toUpperCase()[0]

        // Match: same portal, same last name + first initial, different deal_id
        const { rows: nameMatch } = await db.query(
          `SELECT deal_id, status, docs_requested_at, customer_name FROM finance_monitor_deals
           WHERE portal = $1 AND deal_id != $2
             AND (
               -- "LAST, FIRST..." format: match last name before comma + first char after comma
               (customer_name LIKE '%,%' AND UPPER(SPLIT_PART(customer_name, ',', 1)) = $3
                AND UPPER(TRIM(LEADING ' ' FROM SPLIT_PART(customer_name, ',', 2))) LIKE $4)
               OR
               -- Exact match fallback
               LOWER(customer_name) = LOWER($5)
             )`,
          [portal, deal.dealId, lastName, firstInitial + '%', deal.customerName]
        )
        if (nameMatch.length > 0) {
          // Same customer already exists under a different deal_id — update that row instead
          const old = nameMatch[0]
          const oldDealId = old.deal_id

          // Prefer the numeric / newer deal_id
          const useNewId = /^\d+$/.test(deal.dealId) && !/^\d+$/.test(oldDealId)

          // Use the longer (more complete) customer name
          const bestName = (deal.customerName || '').length >= (old.customer_name || '').length
            ? deal.customerName : old.customer_name

          if (old.status !== deal.status) {
            changedCount++
            let docsRequestedAt = old.docs_requested_at
            if ((deal.status === 'Awaiting Docs' || deal.status === 'Approved - Need Docs') && !old.docs_requested_at) {
              docsRequestedAt = new Date()
            }

            await db.query(`
              UPDATE finance_monitor_deals SET
                deal_id = $1, customer_name = $2, coapplicant = $3, submitted_date = $4, assigned_user = $5,
                decision = $6, discount = $7, funding_requirements = $8,
                status = $9, last_status = $10, status_changed_at = $11,
                docs_requested_at = $12, last_checked_at = $13, updated_at = $13,
                finance_amount = $14, buy_rate = $15, tier = $16, reference_number = $17, option_code = $18,
                exp_date = $19, funding_date = $20, rescind_date = $21, state = $22, address = $23,
                phone = COALESCE($24, phone), city = COALESCE($25, city), zip = COALESCE($26, zip), email = COALESCE($27, email)
              WHERE deal_id = $28 AND portal = $29
            `, [
              useNewId ? deal.dealId : oldDealId,
              bestName, deal.coapplicant, deal.submittedDate, deal.assignedUser,
              deal.decision, deal.discount, deal.fundingRequirements,
              deal.status, old.status, new Date(), docsRequestedAt, new Date(),
              deal.financeAmount, deal.buyRate, deal.tier, deal.referenceNumber, deal.optionCode,
              deal.expDate, deal.fundingDate, deal.rescindDate, deal.state, deal.address,
              deal.phone, deal.city, deal.zip, deal.email,
              oldDealId, portal,
            ])

            await db.query(`
              INSERT INTO finance_monitor_history (deal_id, portal, old_status, new_status, changed_at)
              VALUES ($1, $2, $3, $4, $5)
            `, [useNewId ? deal.dealId : oldDealId, portal, old.status, deal.status, new Date()])

            alerts.push({
              type: 'status_change',
              dealId: useNewId ? deal.dealId : oldDealId,
              customerName: bestName,
              oldStatus: old.status,
              newStatus: deal.status,
            })
          } else {
            // Same status — just update fields + deal_id if needed
            await db.query(`
              UPDATE finance_monitor_deals SET
                deal_id = $1, last_checked_at = $2, updated_at = $2,
                customer_name = $3, coapplicant = $4, assigned_user = $5, decision = $6, discount = COALESCE($7, discount),
                finance_amount = COALESCE($8, finance_amount), buy_rate = COALESCE($9, buy_rate), tier = COALESCE($10, tier), reference_number = COALESCE($11, reference_number), option_code = COALESCE($12, option_code),
                exp_date = COALESCE($13, exp_date), funding_date = COALESCE($14, funding_date), rescind_date = COALESCE($15, rescind_date), state = COALESCE($16, state), address = COALESCE($17, address),
                phone = COALESCE($18, phone), city = COALESCE($19, city), zip = COALESCE($20, zip), email = COALESCE($21, email)
              WHERE deal_id = $22 AND portal = $23
            `, [
              useNewId ? deal.dealId : oldDealId, new Date(),
              bestName, deal.coapplicant, deal.assignedUser, deal.decision, deal.discount,
              deal.financeAmount, deal.buyRate, deal.tier, deal.referenceNumber, deal.optionCode,
              deal.expDate, deal.fundingDate, deal.rescindDate, deal.state, deal.address,
              deal.phone, deal.city, deal.zip, deal.email,
              oldDealId, portal
            ])
          }
          continue // Skip the normal insert/update flow
        }
      }

      const now = new Date()

      if (existing.length === 0) {
        // Insert new deal
        const docsRequestedAt = deal.status === 'Awaiting Docs' || deal.status === 'Approved - Need Docs' ? now : null
        await db.query(`
          INSERT INTO finance_monitor_deals 
            (deal_id, portal, customer_name, coapplicant, submitted_date, assigned_user, decision, discount,
             funding_requirements, status, docs_requested_at, last_checked_at, created_at, updated_at,
             finance_amount, buy_rate, tier, reference_number, option_code, exp_date, funding_date, rescind_date,
             state, address, phone, city, zip, email)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28)
        `, [
          deal.dealId, portal, deal.customerName, deal.coapplicant, deal.submittedDate,
          deal.assignedUser, deal.decision, deal.discount,
          deal.fundingRequirements, deal.status, docsRequestedAt, now, now, now,
          deal.financeAmount, deal.buyRate, deal.tier, deal.referenceNumber, deal.optionCode,
          deal.expDate, deal.fundingDate, deal.rescindDate, deal.state, deal.address,
          deal.phone, deal.city, deal.zip, deal.email,
        ])
        newCount++
      } else {
        const old = existing[0]
        if (old.status !== deal.status) {
          // Status changed!
          changedCount++

          let docsRequestedAt = old.docs_requested_at
          if (deal.status === 'Awaiting Docs' && !old.docs_requested_at) {
            docsRequestedAt = now
          }

          await db.query(`
            UPDATE finance_monitor_deals SET
              customer_name = $1, coapplicant = $2, submitted_date = $3, assigned_user = $4,
              decision = $5, discount = $6, funding_requirements = $7,
              status = $8, last_status = $9, status_changed_at = $10,
              docs_requested_at = $11, last_checked_at = $12, updated_at = $13,
              finance_amount = $14, buy_rate = $15, tier = $16, reference_number = $17, option_code = $18,
              exp_date = $19, funding_date = $20, rescind_date = $21, state = $22, address = $23,
              phone = COALESCE($24, phone), city = COALESCE($25, city), zip = COALESCE($26, zip), email = COALESCE($27, email)
            WHERE deal_id = $28 AND portal = $29
          `, [
            deal.customerName, deal.coapplicant, deal.submittedDate, deal.assignedUser,
            deal.decision, deal.discount, deal.fundingRequirements,
            deal.status, old.status, now, docsRequestedAt, now, now,
            deal.financeAmount, deal.buyRate, deal.tier, deal.referenceNumber, deal.optionCode,
            deal.expDate, deal.fundingDate, deal.rescindDate, deal.state, deal.address,
            deal.phone, deal.city, deal.zip, deal.email,
            deal.dealId, portal,
          ])

          // Log to history
          await db.query(`
            INSERT INTO finance_monitor_history (deal_id, portal, old_status, new_status, changed_at)
            VALUES ($1, $2, $3, $4, $5)
          `, [deal.dealId, portal, old.status, deal.status, now])

          alerts.push({
            type: 'status_change',
            dealId: deal.dealId,
            customerName: deal.customerName,
            oldStatus: old.status,
            newStatus: deal.status,
          })
        } else {
          // No status change, just update fields
          await db.query(`
            UPDATE finance_monitor_deals SET 
              last_checked_at = $1, updated_at = $1,
              customer_name = $2, coapplicant = $3, assigned_user = $4, decision = $5, discount = $6,
              finance_amount = $7, buy_rate = $8, tier = $9, reference_number = $10, option_code = $11,
              exp_date = $12, funding_date = $13, rescind_date = $14, state = $15, address = $16,
              phone = COALESCE($17, phone), city = COALESCE($18, city), zip = COALESCE($19, zip), email = COALESCE($20, email)
            WHERE deal_id = $21 AND portal = $22
          `, [
            now, deal.customerName, deal.coapplicant, deal.assignedUser, deal.decision, deal.discount,
            deal.financeAmount, deal.buyRate, deal.tier, deal.referenceNumber, deal.optionCode,
            deal.expDate, deal.fundingDate, deal.rescindDate, deal.state, deal.address,
            deal.phone, deal.city, deal.zip, deal.email,
            deal.dealId, portal
          ])
        }
      }
    }

    res.json({ ok: true, newCount, changedCount, alerts, totalProcessed: deals.length })
  } catch (err) {
    console.error('[DealTracker] POST /sync error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── POST /api/deal-tracker/init-db ──────────────────────────────────────────
// One-time: create tables if they don't exist
router.post('/deal-tracker/init-db', async (req, res) => {
  try {
    const db = getDb()
    await db.query(`
      CREATE TABLE IF NOT EXISTS finance_monitor_deals (
        deal_id             TEXT NOT NULL,
        portal              TEXT NOT NULL,
        customer_name       TEXT NOT NULL,
        submitted_date      TEXT,
        assigned_user       TEXT,
        decision            TEXT,
        discount            NUMERIC(5,2),
        funding_requirements TEXT,
        status              TEXT NOT NULL,
        last_status         TEXT,
        status_changed_at   TIMESTAMPTZ,
        docs_requested_at   TIMESTAMPTZ,
        last_checked_at     TIMESTAMPTZ,
        created_at          TIMESTAMPTZ DEFAULT NOW(),
        updated_at          TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (deal_id, portal)
      );

      CREATE TABLE IF NOT EXISTS finance_monitor_history (
        id          SERIAL PRIMARY KEY,
        deal_id     TEXT NOT NULL,
        portal      TEXT NOT NULL,
        old_status  TEXT,
        new_status  TEXT NOT NULL,
        changed_at  TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_fm_deals_portal ON finance_monitor_deals(portal);
      CREATE INDEX IF NOT EXISTS idx_fm_deals_status ON finance_monitor_deals(status);
      CREATE INDEX IF NOT EXISTS idx_fm_deals_customer ON finance_monitor_deals(customer_name);
      CREATE INDEX IF NOT EXISTS idx_fm_history_deal ON finance_monitor_history(deal_id, portal);
    `)

    // Add new columns (safe — IF NOT EXISTS equivalent via DO block)
    const newCols = [
      ['coapplicant', 'TEXT'],
      ['finance_amount', 'NUMERIC(10,2)'],
      ['buy_rate', 'NUMERIC(5,2)'],
      ['tier', 'INTEGER'],
      ['reference_number', 'TEXT'],
      ['option_code', 'TEXT'],
      ['exp_date', 'TEXT'],
      ['funding_date', 'TEXT'],
      ['rescind_date', 'TEXT'],
      ['state', 'TEXT'],
      ['address', 'TEXT'],
      ['phone', 'TEXT'],
      ['city', 'TEXT'],
      ['zip', 'TEXT'],
      ['email', 'TEXT'],
    ]
    for (const [col, type] of newCols) {
      await db.query(`
        DO $$ BEGIN
          ALTER TABLE finance_monitor_deals ADD COLUMN ${col} ${type};
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $$;
      `)
    }

    res.json({ ok: true, message: 'Finance monitor tables created + columns updated' })
  } catch (err) {
    console.error('[DealTracker] init-db error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── POST /api/deal-tracker/cleanup-dupes ─────────────────────────────────────
// Remove duplicate deals: generated-ID dupes + same customer/portal dupes (keep newest)
router.post('/deal-tracker/cleanup-dupes', async (req, res) => {
  try {
    const db = getDb()

    // Pass 1: Remove non-numeric IDs where a numeric duplicate exists
    const { rows: dupes1 } = await db.query(`
      DELETE FROM finance_monitor_deals
      WHERE deal_id !~ '^[0-9]+$'
        AND EXISTS (
          SELECT 1 FROM finance_monitor_deals d2
          WHERE d2.deal_id ~ '^[0-9]+$'
            AND d2.portal = finance_monitor_deals.portal
            AND d2.customer_name = finance_monitor_deals.customer_name
            AND COALESCE(d2.submitted_date, '') = COALESCE(finance_monitor_deals.submitted_date, '')
        )
      RETURNING deal_id, portal, customer_name
    `)

    // Pass 2: Same customer + same portal but different deal_ids — keep the one with the latest updated_at
    // Use last name + first initial for matching to catch abbreviated vs full names (e.g., "HAWK, C" vs "HAWK, CHRISTOPHER")
    const { rows: dupes2 } = await db.query(`
      DELETE FROM finance_monitor_deals
      WHERE ctid NOT IN (
        SELECT DISTINCT ON (
          portal,
          UPPER(SPLIT_PART(customer_name, ',', 1)),
          UPPER(LEFT(TRIM(LEADING ' ' FROM SPLIT_PART(customer_name, ',', 2)), 1))
        ) ctid
        FROM finance_monitor_deals
        WHERE customer_name LIKE '%,%'
        ORDER BY
          portal,
          UPPER(SPLIT_PART(customer_name, ',', 1)),
          UPPER(LEFT(TRIM(LEADING ' ' FROM SPLIT_PART(customer_name, ',', 2)), 1)),
          CASE WHEN deal_id ~ '^[0-9]+$' THEN 0 ELSE 1 END,
          updated_at DESC NULLS LAST
      )
      AND customer_name LIKE '%,%'
      AND EXISTS (
        SELECT 1 FROM finance_monitor_deals d2
        WHERE d2.portal = finance_monitor_deals.portal
          AND d2.ctid != finance_monitor_deals.ctid
          AND UPPER(SPLIT_PART(d2.customer_name, ',', 1)) = UPPER(SPLIT_PART(finance_monitor_deals.customer_name, ',', 1))
          AND UPPER(LEFT(TRIM(LEADING ' ' FROM SPLIT_PART(d2.customer_name, ',', 2)), 1))
            = UPPER(LEFT(TRIM(LEADING ' ' FROM SPLIT_PART(finance_monitor_deals.customer_name, ',', 2)), 1))
      )
      RETURNING deal_id, portal, customer_name
    `)

    // Pass 3: Exact name dupes (non-comma format or same exact name)
    const { rows: dupes3 } = await db.query(`
      DELETE FROM finance_monitor_deals
      WHERE ctid NOT IN (
        SELECT DISTINCT ON (portal, LOWER(customer_name)) ctid
        FROM finance_monitor_deals
        ORDER BY portal, LOWER(customer_name), updated_at DESC NULLS LAST
      )
      AND LOWER(customer_name) IN (
        SELECT LOWER(customer_name) FROM finance_monitor_deals
        GROUP BY portal, LOWER(customer_name) HAVING COUNT(*) > 1
      )
      RETURNING deal_id, portal, customer_name
    `)

    const allDupes = [...dupes1, ...dupes2, ...dupes3]

    // Clean up history for deleted IDs
    for (const d of allDupes) {
      await db.query('DELETE FROM finance_monitor_history WHERE deal_id = $1 AND portal = $2', [d.deal_id, d.portal])
    }

    res.json({
      ok: true,
      deleted: allDupes.length,
      pass1_generated_ids: dupes1.length,
      pass2_fuzzy_name: dupes2.length,
      pass3_exact_name: dupes3.length,
      removed: allDupes.map(d => ({ dealId: d.deal_id, name: d.customer_name })),
    })
  } catch (err) {
    console.error('[DealTracker] cleanup-dupes error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router
