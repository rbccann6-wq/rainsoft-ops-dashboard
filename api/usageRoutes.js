/**
 * AI Usage & Cost Tracking
 * Logs token usage per agent/model and calculates costs.
 * Uses Anthropic token pricing (per million tokens).
 */

import express from 'express'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const USAGE_PATH = path.join(__dirname, '..', 'data', 'usage-log.json')

const router = express.Router()

// ─── Pricing (per million tokens, as of March 2026) ──────────────────────────

const PRICING = {
  // Anthropic
  'claude-sonnet-4-6':      { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75 },
  'claude-haiku-4-5':       { input: 0.80,  output: 4.00,  cacheRead: 0.08,  cacheWrite: 1.00 },
  'claude-opus-4-5':        { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
  // Gemini (for Amp/Scout/Inbox)
  'gemini-2.5-flash':       { input: 0.15,  output: 0.60,  cacheRead: 0.037, cacheWrite: 0 },
  'gemini-2.0-flash':       { input: 0.10,  output: 0.40,  cacheRead: 0.025, cacheWrite: 0 },
  'gemini-2.0-flash-lite':  { input: 0.075, output: 0.30,  cacheRead: 0.018, cacheWrite: 0 },
  'gemini-1.5-flash':       { input: 0.075, output: 0.30,  cacheRead: 0.018, cacheWrite: 0 },
  'gemini-2.5-pro':         { input: 1.25,  output: 10.00, cacheRead: 0.31,  cacheWrite: 0 },
}

function getPricing(model) {
  // Fuzzy match model names
  for (const [key, price] of Object.entries(PRICING)) {
    if (model.toLowerCase().includes(key.toLowerCase()) || key.toLowerCase().includes(model.toLowerCase())) {
      return price
    }
  }
  // Default to Sonnet pricing if unknown
  return PRICING['claude-sonnet-4-6']
}

function calcCost(usage, model) {
  const p = getPricing(model)
  const inputCost  = ((usage.inputTokens   ?? 0) / 1_000_000) * p.input
  const outputCost = ((usage.outputTokens  ?? 0) / 1_000_000) * p.output
  const cacheReadCost  = ((usage.cacheReadTokens  ?? 0) / 1_000_000) * p.cacheRead
  const cacheWriteCost = ((usage.cacheWriteTokens ?? 0) / 1_000_000) * p.cacheWrite
  return inputCost + outputCost + cacheReadCost + cacheWriteCost
}

// ─── Storage helpers ──────────────────────────────────────────────────────────

function loadUsage() {
  try {
    if (fs.existsSync(USAGE_PATH)) return JSON.parse(fs.readFileSync(USAGE_PATH, 'utf8'))
  } catch { /* ignore */ }
  return { entries: [], lastUpdated: null }
}

function saveUsage(data) {
  fs.mkdirSync(path.dirname(USAGE_PATH), { recursive: true })
  fs.writeFileSync(USAGE_PATH, JSON.stringify(data))
}

// ─── POST /api/usage/log — log a usage event ─────────────────────────────────

router.post('/usage/log', (req, res) => {
  const { agent, model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, sessionKey } = req.body
  if (!agent || !model) return res.status(400).json({ error: 'agent and model required' })

  const usage = { inputTokens: inputTokens ?? 0, outputTokens: outputTokens ?? 0, cacheReadTokens: cacheReadTokens ?? 0, cacheWriteTokens: cacheWriteTokens ?? 0 }
  const cost = calcCost(usage, model)

  const entry = {
    timestamp: new Date().toISOString(),
    agent,
    model,
    ...usage,
    costUsd: Math.round(cost * 1_000_000) / 1_000_000, // 6 decimal places
    sessionKey: sessionKey ?? null,
  }

  const data = loadUsage()
  data.entries.push(entry)
  data.lastUpdated = entry.timestamp
  saveUsage(data)

  res.json({ success: true, costUsd: entry.costUsd })
})

// ─── GET /api/usage — summary + recent entries ───────────────────────────────

router.get('/usage', (req, res) => {
  const data = loadUsage()
  const entries = data.entries ?? []

  const now = Date.now()
  const day  = 86400000
  const week = 7 * day
  const month = 30 * day

  function sumEntries(filtered) {
    return {
      totalCostUsd: filtered.reduce((s, e) => s + (e.costUsd ?? 0), 0),
      inputTokens:  filtered.reduce((s, e) => s + (e.inputTokens ?? 0), 0),
      outputTokens: filtered.reduce((s, e) => s + (e.outputTokens ?? 0), 0),
      calls: filtered.length,
    }
  }

  // By agent
  const byAgent = {}
  for (const e of entries) {
    if (!byAgent[e.agent]) byAgent[e.agent] = { agent: e.agent, model: e.model, entries: [] }
    byAgent[e.agent].entries.push(e)
  }
  const agentSummary = Object.values(byAgent).map(a => ({
    agent: a.agent,
    model: a.model,
    ...sumEntries(a.entries),
    lastSeen: a.entries[a.entries.length - 1]?.timestamp,
  })).sort((a, b) => b.totalCostUsd - a.totalCostUsd)

  res.json({
    today:   sumEntries(entries.filter(e => now - new Date(e.timestamp) < day)),
    week:    sumEntries(entries.filter(e => now - new Date(e.timestamp) < week)),
    month:   sumEntries(entries.filter(e => now - new Date(e.timestamp) < month)),
    allTime: sumEntries(entries),
    byAgent: agentSummary,
    recentEntries: entries.slice(-20).reverse(),
    lastUpdated: data.lastUpdated,
  })
})

export default router
