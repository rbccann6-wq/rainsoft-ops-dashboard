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
    const { portal, status, search, page = 1, limit = 50 } = req.query
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

    // Get deals with optional join to main deals table for extra info
    const query = `
      SELECT 
        fm.*,
        NULL::numeric as sale_amount,
        NULL::text as deal_source,
        NULL::text as sales_rep,
        NULL::numeric as finance_amount,
        NULL::date as sale_date,
        NULL::text as deal_notes
      FROM finance_monitor_deals fm
      ${whereClause}
      ORDER BY fm.updated_at DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `
    params.push(parseInt(limit), offset)

    const { rows } = await db.query(query, params)

    // Get total count
    const countQuery = `SELECT COUNT(*) FROM finance_monitor_deals fm ${whereClause}`
    const countParams = params.slice(0, params.length - 2) // remove limit/offset
    const { rows: countRows } = await db.query(countQuery, countParams)

    // Check which customers have multi-portal submissions
    const multiQuery = `
      SELECT customer_name FROM finance_monitor_deals
      GROUP BY customer_name HAVING COUNT(DISTINCT portal) > 1
    `
    const { rows: multiRows } = await db.query(multiQuery)
    const multiCustomers = new Set(multiRows.map(r => r.customer_name))

    const enriched = rows.map(row => {
      row.isMultiSubmit = multiCustomers.has(row.customer_name)
      return toCamel(row)
    })

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

    // Find best rate per customer (lowest discount among approved)
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
      // Check existing
      const { rows: existing } = await db.query(
        'SELECT status, docs_requested_at FROM finance_monitor_deals WHERE deal_id = $1 AND portal = $2',
        [deal.dealId, portal]
      )

      const now = new Date()

      if (existing.length === 0) {
        // Insert new deal
        const docsRequestedAt = deal.status === 'Awaiting Docs' || deal.status === 'Approved - Need Docs' ? now : null
        await db.query(`
          INSERT INTO finance_monitor_deals 
            (deal_id, portal, customer_name, coapplicant, submitted_date, assigned_user, decision, discount,
             funding_requirements, status, docs_requested_at, last_checked_at, created_at, updated_at,
             finance_amount, buy_rate, tier, reference_number, option_code, exp_date, funding_date, rescind_date, state, address)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
        `, [
          deal.dealId, portal, deal.customerName, deal.coapplicant, deal.submittedDate,
          deal.assignedUser, deal.decision, deal.discount,
          deal.fundingRequirements, deal.status, docsRequestedAt, now, now, now,
          deal.financeAmount, deal.buyRate, deal.tier, deal.referenceNumber, deal.optionCode,
          deal.expDate, deal.fundingDate, deal.rescindDate, deal.state, deal.address,
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
              exp_date = $19, funding_date = $20, rescind_date = $21, state = $22, address = $23
            WHERE deal_id = $24 AND portal = $25
          `, [
            deal.customerName, deal.coapplicant, deal.submittedDate, deal.assignedUser,
            deal.decision, deal.discount, deal.fundingRequirements,
            deal.status, old.status, now, docsRequestedAt, now, now,
            deal.financeAmount, deal.buyRate, deal.tier, deal.referenceNumber, deal.optionCode,
            deal.expDate, deal.fundingDate, deal.rescindDate, deal.state, deal.address,
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
              exp_date = $12, funding_date = $13, rescind_date = $14, state = $15, address = $16
            WHERE deal_id = $17 AND portal = $18
          `, [
            now, deal.customerName, deal.coapplicant, deal.assignedUser, deal.decision, deal.discount,
            deal.financeAmount, deal.buyRate, deal.tier, deal.referenceNumber, deal.optionCode,
            deal.expDate, deal.fundingDate, deal.rescindDate, deal.state, deal.address,
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
    res.json({ ok: true, message: 'Finance monitor tables created' })
  } catch (err) {
    console.error('[DealTracker] init-db error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router
