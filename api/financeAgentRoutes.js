/**
 * Finance Agent Routes
 * Logging + querying credit app runs processed by the finance agent.
 */

import express from 'express'
import { createClient } from '@supabase/supabase-js'

const router = express.Router()

function getSupabase() {
  return createClient(
    process.env.SUPABASE_URL || 'https://njqavagyuwdmkeyoscbz.supabase.co',
    process.env.SUPABASE_SERVICE_KEY ||
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5qcWF2YWd5dXdkbWtleW9zY2J6Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3Mzc1NTM4MywiZXhwIjoyMDg5MzMxMzgzfQ.67pxlJAlqIKgTgDwpoDBcQZ12ezT3ZPbQRXsBnRptPs'
  )
}

// ── POST /api/finance-agent/log ───────────────────────────────────────────────
router.post('/finance-agent/log', async (req, res) => {
  try {
    const supabase = getSupabase()
    const run = {
      run_id:            req.body.run_id || `run-${Date.now()}`,
      applicant_name:    req.body.applicant_name   || null,
      co_applicant_name: req.body.co_applicant_name || null,
      sale_amount:       req.body.sale_amount       || null,
      amount_financed:   req.body.amount_financed   || null,
      product:           req.body.product           || null,
      lead_source:       req.body.lead_source       || null,
      promo:             req.body.promo             || null,
      portal:            req.body.portal            || null,
      status:            req.body.status            || 'unknown',
      stops:             req.body.stops             || null,
      skip_reason:       req.body.skip_reason       || null,
      result_summary:    req.body.result_summary     || null,
      sales_rep:         req.body.sales_rep          || null,
      install_date:      req.body.install_date       || null,
      email_subject:     req.body.email_subject      || null,
      email_received_at: req.body.email_received_at  || null,
      error_message:     req.body.error_message      || null,
    }
    const { error } = await supabase.from('finance_agent_runs').upsert(run, { onConflict: 'run_id' })
    if (error) throw error
    res.json({ ok: true })
  } catch (err) {
    console.error('POST /finance-agent/log:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

// ── GET /api/finance-agent/runs ───────────────────────────────────────────────
router.get('/finance-agent/runs', async (req, res) => {
  try {
    const supabase = getSupabase()
    const limit = parseInt(req.query.limit) || 50
    const { data, error } = await supabase
      .from('finance_agent_runs')
      .select('*')
      .order('processed_at', { ascending: false })
      .limit(limit)
    if (error) throw error
    res.json(data || [])
  } catch (err) {
    console.error('GET /finance-agent/runs:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/finance-agent/stats ─────────────────────────────────────────────
router.get('/finance-agent/stats', async (req, res) => {
  try {
    const supabase = getSupabase()
    const { data, error } = await supabase
      .from('finance_agent_runs')
      .select('status, processed_at')
    if (error) throw error

    const now = new Date()
    const weekAgo   = new Date(now - 7  * 24 * 60 * 60 * 1000)
    const monthAgo  = new Date(now - 30 * 24 * 60 * 60 * 1000)

    const rows = data || []
    const count = (fn) => rows.filter(fn).length

    res.json({
      total:     rows.length,
      approved:  count(r => r.status === 'approved'),
      declined:  count(r => r.status === 'declined'),
      pending:   count(r => r.status === 'pending'),
      stopped:   count(r => r.status === 'stopped'),
      skipped:   count(r => r.status === 'skipped'),
      error:     count(r => r.status === 'error'),
      thisWeek:  count(r => new Date(r.processed_at) >= weekAgo),
      thisMonth: count(r => new Date(r.processed_at) >= monthAgo),
    })
  } catch (err) {
    console.error('GET /finance-agent/stats:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/finance-agent/status ────────────────────────────────────────────
router.get('/finance-agent/status', async (req, res) => {
  try {
    // Load subscription data from the cached file
    const fs = await import('fs')
    const path = await import('path')
    const subPath = path.default.join(process.cwd(), 'data', 'graph-subscription.json')
    if (!fs.default.existsSync(subPath)) {
      return res.json({ subscribed: false, message: 'No subscription registered yet' })
    }
    const sub = JSON.parse(fs.default.readFileSync(subPath, 'utf8'))
    const expiresAt = new Date(sub.expirationDateTime)
    const hoursLeft = Math.round((expiresAt - Date.now()) / (1000 * 60 * 60))
    res.json({
      subscribed:     true,
      subscriptionId: sub.id,
      expiresAt:      sub.expirationDateTime,
      hoursLeft,
      healthy:        hoursLeft > 0,
    })
  } catch (err) {
    res.json({ subscribed: false, error: err.message })
  }
})

export default router
