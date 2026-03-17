import 'dotenv/config'
import express from 'express'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import cors from 'cors'
import emailRoutes from './api/emailRoutes.js'
import leadsRoutes from './api/leadsRoutes.js'
import crmRoutes from './api/crmRoutes.js'
import billsRoutes from './api/billsRoutes.js'
import cleanerRoutes from './api/cleanerRoutes.js'
import safelistRoutes from './api/safelistRoutes.js'
import usageRoutes from './api/usageRoutes.js'
import migrationRoutes from './api/migrationRoutes.js'
import webhookRoutes, { ensureSubscription } from './api/webhookRoutes.js'
import financeAgentRoutes from './api/financeAgentRoutes.js'
import emailPollerRoutes, { startPoller } from './api/emailPollerRoutes.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const app = express()
const PORT = process.env.PORT || 3000

app.use(cors())
app.use(express.json())

// API routes
app.use('/api', emailRoutes)
app.use('/api', leadsRoutes)
app.use('/api', crmRoutes)
app.use('/api', billsRoutes)
app.use('/api', cleanerRoutes)
app.use('/api', safelistRoutes)
app.use('/api', usageRoutes)
app.use('/api', migrationRoutes)
app.use('/api', webhookRoutes)
app.use('/api', financeAgentRoutes)
app.use('/api', emailPollerRoutes)

// Serve built React app
app.use(express.static(join(__dirname, 'dist')))

// SPA fallback — must come after /api
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'))
})

app.listen(PORT, async () => {
  console.log(`RainSoft Ops Dashboard running on port ${PORT}`)

  // Start delta poller for FastField emails (replaces webhook — works through Cloudflare)
  startPoller()

  // Nightly purge of temp PDF copies (originals stay in M365 inbox)
  try {
    const financeAgentPath = process.env.FINANCE_AGENT_PATH || '/Users/rebeccasbot/Projects/finance-agent'
    const { schedulePurge } = await import(`${financeAgentPath}/src/pdfPurge.js`)
    schedulePurge()
  } catch { /* finance-agent not available in this env — skip */ }
})
