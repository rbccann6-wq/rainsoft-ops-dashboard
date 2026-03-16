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

// Serve built React app
app.use(express.static(join(__dirname, 'dist')))

// SPA fallback — must come after /api
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'dist', 'index.html'))
})

app.listen(PORT, () => {
  console.log(`RainSoft Ops Dashboard running on port ${PORT}`)
})
