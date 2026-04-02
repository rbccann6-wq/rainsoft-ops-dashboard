import pg from 'pg'
const { Pool } = pg

let pool = null

export function getDb() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL not set — database not connected')
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DB_SSL === 'false' ? false
         : process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false }
         : false,
      max: 10,
    })
    pool.on('error', (err) => {
      console.error('Database pool error:', err.message)
    })
  }
  return pool
}

export async function withRetry(fn, label, max = 3) {
  let lastErr
  for (let i = 1; i <= max; i++) {
    try { return await fn() } catch (err) {
      lastErr = err
      console.warn(`[${label}] attempt ${i}/${max} failed:`, err.message)
      if (i < max) await new Promise(r => setTimeout(r, 1000 * i))
    }
  }
  throw new Error(`[${label}] failed after ${max} attempts: ${lastErr.message}`)
}

export async function initDb() {
  const db = getDb()
  const fs = await import('fs')
  const path = await import('path')
  const { fileURLToPath } = await import('url')
  const __dirname = path.dirname(fileURLToPath(import.meta.url))
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8')
  await db.query(schema)
  console.log('Database schema initialized')
}
