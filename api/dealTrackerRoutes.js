/**
 * Deal Tracker Routes — Finance portal deal status monitoring
 * Reads from PostgreSQL finance_monitor_deals + finance_monitor_history tables
 */
import express from 'express'
import { getDb } from './db/index.js'

const router = express.Router()

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
        d.sale_amount,
        d.deal_source,
        d.sales_rep,
        d.finance_amount,
        d.sale_date,
        d.notes as deal_notes
      FROM finance_monitor_deals fm
      LEFT JOIN deals d ON UPPER(TRIM(d.customer_name)) = UPPER(TRIM(fm.customer_name))
        AND LOWER(d.finance_company) = LOWER(fm.portal)
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

    const enriched = rows.map(row => ({
      ...row,
      isMultiSubmit: multiCustomers.has(row.customer_name),
    }))

    res.json({
      deals: enriched,
      total: parseInt(countRows[0].count),
      page: parseInt(page),
      limit: parseInt(limit),
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
        const best = approved.reduce((a, b) => (a.discount < b.discount ? a : b))
        bestDealId = best.deal_id
      }
      return {
        customerName: name,
        deals: deals.map(d => ({
          ...d,
          isBestRate: d.deal_id === bestDealId,
        })),
      }
    })

    res.json(comparisons)
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
      deal,
      history: historyResult.rows,
      relatedDeals,
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
        const docsRequestedAt = deal.status === 'Awaiting Docs' ? now : null
        await db.query(`
          INSERT INTO finance_monitor_deals 
            (deal_id, portal, customer_name, submitted_date, assigned_user, decision, discount,
             funding_requirements, status, docs_requested_at, last_checked_at, created_at, updated_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        `, [
          deal.dealId, portal, deal.customerName, deal.submittedDate,
          deal.assignedUser, deal.decision, deal.discount,
          deal.fundingRequirements, deal.status, docsRequestedAt, now, now, now,
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
              customer_name = $1, submitted_date = $2, assigned_user = $3,
              decision = $4, discount = $5, funding_requirements = $6,
              status = $7, last_status = $8, status_changed_at = $9,
              docs_requested_at = $10, last_checked_at = $11, updated_at = $12
            WHERE deal_id = $13 AND portal = $14
          `, [
            deal.customerName, deal.submittedDate, deal.assignedUser,
            deal.decision, deal.discount, deal.fundingRequirements,
            deal.status, old.status, now, docsRequestedAt, now, now,
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
          // No status change, just update last_checked
          await db.query(`
            UPDATE finance_monitor_deals SET 
              last_checked_at = $1, updated_at = $1,
              customer_name = $2, assigned_user = $3, decision = $4, discount = $5
            WHERE deal_id = $6 AND portal = $7
          `, [now, deal.customerName, deal.assignedUser, deal.decision, deal.discount, deal.dealId, portal])
        }
      }
    }

    res.json({ ok: true, newCount, changedCount, alerts, totalProcessed: deals.length })
  } catch (err) {
    console.error('[DealTracker] POST /sync error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router
