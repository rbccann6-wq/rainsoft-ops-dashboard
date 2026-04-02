import express from 'express'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import os from 'os'
import db from './db/index.js'

const require = createRequire(import.meta.url)
const router = express.Router()

// Path to the finance-monitor SQLite DB
const SQLITE_DB_PATH = join(os.homedir(), 'Projects', 'finance-monitor', 'data', 'deals.db')

function getSqliteDb() {
  try {
    const Database = require('better-sqlite3')
    return new Database(SQLITE_DB_PATH, { readonly: true })
  } catch (err) {
    console.error('[DealTracker] Failed to open SQLite DB:', err.message)
    return null
  }
}

// Helper: normalize customer name for matching (uppercase, trim)
function normalizeName(name) {
  if (!name) return ''
  return name.trim().toUpperCase()
}

// GET /api/deal-tracker/deals
// Query params: portal, status, search, page, limit
router.get('/deal-tracker/deals', async (req, res) => {
  try {
    const { portal, status, search, page = 1, limit = 50 } = req.query
    const offset = (parseInt(page) - 1) * parseInt(limit)

    const sqlite = getSqliteDb()
    if (!sqlite) {
      return res.status(503).json({ error: 'Finance monitor database unavailable' })
    }

    // Build SQLite query
    let sqliteQuery = 'SELECT * FROM deals WHERE 1=1'
    const sqliteParams = []

    if (portal) {
      sqliteQuery += ' AND LOWER(portal) = LOWER(?)'
      sqliteParams.push(portal)
    }
    if (status) {
      sqliteQuery += ' AND status = ?'
      sqliteParams.push(status)
    }
    if (search) {
      sqliteQuery += ' AND LOWER(customerName) LIKE LOWER(?)'
      sqliteParams.push(`%${search}%`)
    }

    sqliteQuery += ' ORDER BY createdAt DESC LIMIT ? OFFSET ?'
    sqliteParams.push(parseInt(limit), offset)

    const sqliteDeals = sqlite.prepare(sqliteQuery).all(...sqliteParams)
    sqlite.close()

    // Count query for pagination
    const sqlite2 = getSqliteDb()
    let countQuery = 'SELECT COUNT(*) as total FROM deals WHERE 1=1'
    const countParams = []
    if (portal) { countQuery += ' AND LOWER(portal) = LOWER(?)'; countParams.push(portal) }
    if (status) { countQuery += ' AND status = ?'; countParams.push(status) }
    if (search)  { countQuery += ' AND LOWER(customerName) LIKE LOWER(?)'; countParams.push(`%${search}%`) }
    const { total } = sqlite2.prepare(countQuery).get(...countParams)
    sqlite2.close()

    // Fetch matching PG records by customer name
    let pgDeals = []
    if (sqliteDeals.length > 0) {
      const names = sqliteDeals.map(d => normalizeName(d.customerName)).filter(Boolean)
      const placeholders = names.map((_, i) => `$${i + 1}`).join(', ')
      try {
        const pgResult = await db.query(
          `SELECT * FROM deals WHERE UPPER(TRIM(customer_name)) IN (${placeholders})`,
          names
        )
        pgDeals = pgResult.rows
      } catch (pgErr) {
        console.warn('[DealTracker] PG query failed (non-fatal):', pgErr.message)
      }
    }

    // Build PG lookup map by normalized name
    const pgMap = {}
    for (const row of pgDeals) {
      const key = normalizeName(row.customer_name)
      if (!pgMap[key]) pgMap[key] = []
      pgMap[key].push(row)
    }

    // Merge SQLite + PG data
    const merged = sqliteDeals.map(deal => {
      const key = normalizeName(deal.customerName)
      const pgMatches = pgMap[key] || []
      const pgDeal = pgMatches[0] || null

      return {
        // SQLite fields
        dealId: deal.dealId,
        portal: deal.portal,
        customerName: deal.customerName,
        submittedDate: deal.submittedDate,
        assignedUser: deal.assignedUser,
        decision: deal.decision,
        discount: deal.discount,
        fundingRequirements: deal.fundingRequirements,
        status: deal.status,
        lastStatus: deal.lastStatus,
        statusChangedAt: deal.statusChangedAt,
        docsRequestedAt: deal.docsRequestedAt,
        lastCheckedAt: deal.lastCheckedAt,
        createdAt: deal.createdAt,
        updatedAt: deal.updatedAt,
        // PG fields (if matched)
        saleAmount: pgDeal?.sale_amount ?? null,
        dealSource: pgDeal?.deal_source ?? null,
        salesRep: pgDeal?.sales_rep ?? null,
        financeAmount: pgDeal?.finance_amount ?? null,
        saleDate: pgDeal?.sale_date ?? null,
        pgNotes: pgDeal?.notes ?? null,
        pgId: pgDeal?.id ?? null,
      }
    })

    res.json({
      deals: merged,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit)),
      }
    })
  } catch (err) {
    console.error('[DealTracker] GET /deals error:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/deal-tracker/comparison
// Returns deals submitted to multiple finance companies, grouped by customer name
router.get('/deal-tracker/comparison', async (req, res) => {
  try {
    const sqlite = getSqliteDb()
    if (!sqlite) {
      return res.status(503).json({ error: 'Finance monitor database unavailable' })
    }

    // Get all deals grouped by customer name where count > 1
    const multiDeals = sqlite.prepare(`
      SELECT customerName, COUNT(*) as portalCount
      FROM deals
      GROUP BY UPPER(TRIM(customerName))
      HAVING COUNT(*) > 1
      ORDER BY portalCount DESC
    `).all()

    if (multiDeals.length === 0) {
      sqlite.close()
      return res.json({ comparisons: [] })
    }

    const customerNames = multiDeals.map(r => normalizeName(r.customerName))
    const placeholders = customerNames.map((_, i) => `?`).join(', ')
    const allDeals = sqlite.prepare(
      `SELECT * FROM deals WHERE UPPER(TRIM(customerName)) IN (${placeholders}) ORDER BY customerName, portal`
    ).all(...customerNames)
    sqlite.close()

    // Group by normalized customer name
    const grouped = {}
    for (const deal of allDeals) {
      const key = normalizeName(deal.customerName)
      if (!grouped[key]) grouped[key] = { customerName: deal.customerName, deals: [] }
      grouped[key].deals.push(deal)
    }

    // For each group, determine best rate (lowest discount = best buy rate)
    const comparisons = Object.values(grouped).map(group => {
      const deals = group.deals
      // Find best approved rate (lowest discount among approved deals)
      const approvedDeals = deals.filter(d => d.decision === 'Approved' && d.discount != null)
      let bestDealId = null
      if (approvedDeals.length > 0) {
        const best = approvedDeals.reduce((a, b) => (a.discount < b.discount ? a : b))
        bestDealId = best.dealId
      }

      return {
        customerName: group.customerName,
        portalCount: deals.length,
        bestDealId,
        deals: deals.map(d => ({
          dealId: d.dealId,
          portal: d.portal,
          decision: d.decision,
          discount: d.discount,
          status: d.status,
          statusChangedAt: d.statusChangedAt,
          submittedDate: d.submittedDate,
          isBestRate: d.dealId === bestDealId,
        }))
      }
    })

    res.json({ comparisons })
  } catch (err) {
    console.error('[DealTracker] GET /comparison error:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/deal-tracker/stats
router.get('/deal-tracker/stats', async (req, res) => {
  try {
    const sqlite = getSqliteDb()
    if (!sqlite) {
      return res.status(503).json({ error: 'Finance monitor database unavailable' })
    }

    // Count by portal
    const byPortal = sqlite.prepare(`
      SELECT portal, COUNT(*) as count FROM deals GROUP BY portal ORDER BY count DESC
    `).all()

    // Count by status
    const byStatus = sqlite.prepare(`
      SELECT status, COUNT(*) as count FROM deals GROUP BY status ORDER BY count DESC
    `).all()

    // Active deals (not Funded or Declined)
    const activeCount = sqlite.prepare(`
      SELECT COUNT(*) as count FROM deals WHERE status NOT IN ('Funded', 'Declined', 'Funding On Hold')
    `).get()

    // Awaiting docs
    const awaitingDocs = sqlite.prepare(`
      SELECT COUNT(*) as count, MIN(docsRequestedAt) as oldestAt
      FROM deals WHERE status = 'Awaiting Docs'
    `).get()

    // Stale docs (12+ hours)
    const twelveHoursAgo = Math.floor(Date.now() / 1000) - (12 * 60 * 60)
    const staleDocs = sqlite.prepare(`
      SELECT COUNT(*) as count FROM deals
      WHERE status = 'Awaiting Docs' AND docsRequestedAt IS NOT NULL AND docsRequestedAt < ?
    `).get(twelveHoursAgo)

    // Multi-submit comparisons
    const multiSubmit = sqlite.prepare(`
      SELECT COUNT(*) as count FROM (
        SELECT customerName FROM deals GROUP BY UPPER(TRIM(customerName)) HAVING COUNT(*) > 1
      )
    `).get()

    // Funded this month
    const now = new Date()
    const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
    const fundedThisMonth = sqlite.prepare(`
      SELECT COUNT(*) as count FROM deals
      WHERE status = 'Funded' AND submittedDate >= ?
    `).get(firstOfMonth)

    // Average discount by portal
    const avgDiscountByPortal = sqlite.prepare(`
      SELECT portal, AVG(discount) as avgDiscount, COUNT(*) as count
      FROM deals WHERE discount IS NOT NULL AND decision = 'Approved'
      GROUP BY portal
    `).all()

    sqlite.close()

    res.json({
      byPortal,
      byStatus,
      activeCount: activeCount.count,
      awaitingDocs: {
        count: awaitingDocs.count,
        oldestAt: awaitingDocs.oldestAt,
      },
      staleDocsCount: staleDocs.count,
      multiSubmitCount: multiSubmit.count,
      fundedThisMonth: fundedThisMonth.count,
      avgDiscountByPortal,
    })
  } catch (err) {
    console.error('[DealTracker] GET /stats error:', err)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/deal-tracker/history/:dealId
router.get('/deal-tracker/history/:dealId', async (req, res) => {
  try {
    const { dealId } = req.params
    const sqlite = getSqliteDb()
    if (!sqlite) {
      return res.status(503).json({ error: 'Finance monitor database unavailable' })
    }

    const history = sqlite.prepare(`
      SELECT * FROM status_history WHERE dealId = ? ORDER BY changedAt ASC
    `).all(dealId)

    const deal = sqlite.prepare(`SELECT * FROM deals WHERE dealId = ?`).get(dealId)
    sqlite.close()

    if (!deal) {
      return res.status(404).json({ error: 'Deal not found' })
    }

    res.json({ deal, history })
  } catch (err) {
    console.error('[DealTracker] GET /history error:', err)
    res.status(500).json({ error: err.message })
  }
})

export default router
