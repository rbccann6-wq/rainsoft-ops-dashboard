/**
 * Pentair Orders & Inventory
 *
 * Polls emails from three senders every 5 minutes using M365 Graph delta queries:
 *   cs.roselle@pentair.com  → Order Acknowledgments + Shipment Notifications
 *   usro2_ar@pentair.com    → Invoice emails (with PDF attachments)
 *   E-BillExpress@E-billexpress.com → Payment confirmation emails
 *
 * Auto-matches invoices → orders by Sales Order #, payments → invoices by SO#.
 * Stores PDF bytes in pentair_invoices.pdf_content.
 */

import express from 'express'
import { ConfidentialClientApplication } from '@azure/msal-node'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import { getDb } from './db/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const router = express.Router()

const PENTAIR_CS      = 'cs.roselle@pentair.com'
const PENTAIR_AR      = 'usro2_ar@pentair.com'
const EBILL_EXPRESS   = 'e-billexpress@e-billexpress.com'
const PENTAIR_SENDERS = new Set([PENTAIR_CS, PENTAIR_AR, EBILL_EXPRESS])

const DELTA_TOKEN_PATH  = path.join(__dirname, '..', 'data', 'pentair-delta-token.json')
const PROCESSED_PATH    = path.join(__dirname, '..', 'data', 'pentair-processed-emails.json')
const POLL_INTERVAL_MS  = 5 * 60 * 1000

// ── MSAL ──────────────────────────────────────────────────────────────────────

let _msalClient = null
function getMsalClient() {
  if (!_msalClient) {
    _msalClient = new ConfidentialClientApplication({
      auth: {
        clientId:     process.env.CLIENT_ID,
        clientSecret: process.env.CLIENT_SECRET,
        authority:    `https://login.microsoftonline.com/${process.env.TENANT_ID}`,
      },
    })
  }
  return _msalClient
}

async function getToken() {
  const r = await getMsalClient().acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  })
  if (!r?.accessToken) throw new Error('Failed to acquire Graph token')
  return r.accessToken
}

// ── Delta token + processed-email persistence ─────────────────────────────────

function loadDeltaToken() {
  try {
    if (fs.existsSync(DELTA_TOKEN_PATH)) {
      return JSON.parse(fs.readFileSync(DELTA_TOKEN_PATH, 'utf8')).deltaToken || null
    }
  } catch {}
  return null
}

function saveDeltaToken(token) {
  fs.mkdirSync(path.dirname(DELTA_TOKEN_PATH), { recursive: true })
  fs.writeFileSync(DELTA_TOKEN_PATH, JSON.stringify({ deltaToken: token, savedAt: new Date().toISOString() }))
}

function loadProcessed() {
  try {
    if (fs.existsSync(PROCESSED_PATH)) return new Set(JSON.parse(fs.readFileSync(PROCESSED_PATH, 'utf8')))
  } catch {}
  return new Set()
}

function saveProcessed(ids) {
  fs.mkdirSync(path.dirname(PROCESSED_PATH), { recursive: true })
  fs.writeFileSync(PROCESSED_PATH, JSON.stringify([...ids]))
}

// ── Alert helper ──────────────────────────────────────────────────────────────

function alert(text) {
  try {
    execSync(`openclaw system event --text "${text.replace(/"/g, "'")}" --mode now`, { timeout: 10000 })
  } catch {}
}

// ── PDF text extraction ───────────────────────────────────────────────────────

async function extractPdfText(buffer) {
  try {
    const { getDocument, GlobalWorkerOptions } = await import('pdfjs-dist/legacy/build/pdf.mjs')
    GlobalWorkerOptions.workerSrc = ''
    const data = new Uint8Array(buffer)
    const doc = await getDocument({
      data,
      useWorkerFetch: false,
      isEvalSupported: false,
      useSystemFonts: true,
    }).promise
    const pages = []
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p)
      const tc = await page.getTextContent()
      pages.push(tc.items.map(i => i.str).join(' '))
    }
    return pages.join('\n')
  } catch (err) {
    console.warn('[pentair] PDF text extraction failed:', err.message)
    return ''
  }
}

// ── Email parsers ─────────────────────────────────────────────────────────────

/**
 * Parse Pentair Order Acknowledgment from email body text.
 * Returns { orderNumber, orderDate, desiredShipDate, customerName, items[] }
 */
function parseOrderAck(subject, bodyText) {
  const text = bodyText.replace(/\s+/g, ' ')

  // Order number — various formats: "Order Number: 12345678", "Order #12345678", subject: "Order Acknowledgement 12345678"
  const orderNumMatch =
    text.match(/order\s*(?:number|#|no\.?)\s*[:\s]\s*(\w[\w-]+)/i) ||
    subject.match(/(\d{6,10})/i)
  const orderNumber = orderNumMatch?.[1]?.trim()

  // Dates
  const orderDateMatch = text.match(/order\s*date\s*[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i)
  const shipDateMatch  = text.match(/(?:desired\s*ship|ship)\s*date\s*[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i)

  const orderDate        = orderDateMatch ? parseMMDDYYYY(orderDateMatch[1]) : null
  const desiredShipDate  = shipDateMatch  ? parseMMDDYYYY(shipDateMatch[1])  : null

  // Customer
  const custMatch = text.match(/(?:customer|sold\s*to|ship\s*to)\s*(?:name)?\s*[:\s]+([^\n\r,]+)/i)
  const customerName = custMatch?.[1]?.trim() || null

  // Items — look for lines: qty  partNumber  description (no price in ack)
  // Pattern: number followed by a part-like token (letters+digits, often with dash)
  const items = []
  const itemPattern = /(\d+)\s+(RS-[\w-]+|[A-Z]{1,4}-?[\w-]+)\s+([A-Z][^\n]{5,60})/gi
  let m
  while ((m = itemPattern.exec(text)) !== null) {
    const qty = parseInt(m[1])
    if (qty > 0 && qty < 10000) {
      items.push({
        quantity_ordered: qty,
        part_id:          m[2].trim().toUpperCase(),
        description:      m[3].trim().replace(/\s{2,}/g, ' '),
        unit_price:       null,
        line_total:       null,
      })
    }
  }

  return { orderNumber, orderDate, desiredShipDate, customerName, items }
}

/**
 * Parse Pentair Shipment Notification from email body text.
 * Returns { packlistNumber, trackingNumber, carrier, shipDate, orderNumber }
 */
function parseShipmentNotice(subject, bodyText) {
  const text = bodyText.replace(/\s+/g, ' ')

  const packlistMatch  = text.match(/pack(?:ing)?\s*list\s*(?:#|number|no\.?)?\s*[:\s]+(\w[\w-]+)/i)
  const trackingMatch  = text.match(/tracking\s*(?:#|number|no\.?)?\s*[:\s]+(1Z[\w]+|[A-Z0-9]{10,30})/i)
  const carrierMatch   = text.match(/(?:carrier|shipped\s*via|via)\s*[:\s]+(UPS|SAIA|FEDEX|FedEx|Federal Express|[A-Z\s]{2,20})/i)
  const shipDateMatch  = text.match(/(?:ship|shipped)\s*date\s*[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i)
  const orderNumMatch  =
    text.match(/order\s*(?:number|#|no\.?)\s*[:\s]+(\w[\w-]+)/i) ||
    subject.match(/(\d{6,10})/)

  return {
    packlistNumber: packlistMatch?.[1]?.trim() || null,
    trackingNumber: trackingMatch?.[1]?.trim() || null,
    carrier:        (carrierMatch?.[1] || '').trim().toUpperCase() || null,
    shipDate:       shipDateMatch ? parseMMDDYYYY(shipDateMatch[1]) : null,
    orderNumber:    orderNumMatch?.[1]?.trim() || null,
  }
}

/**
 * Parse Pentair Invoice from PDF text.
 * Returns { invoiceNumber, salesOrder, invoiceDate, dueDate, subtotal, freight, tax, totalDue, items[], isCredit, isWarranty }
 */
function parseInvoicePdf(pdfText) {
  const text = pdfText.replace(/\s+/g, ' ')

  const invMatch     = text.match(/invoice\s*(?:#|number|no\.?)?\s*[:\s]+([A-Z0-9-]{4,20})/i)
  const soMatch      = text.match(/(?:sales\s*order|SO#?|order\s*#)\s*[:\s]+([A-Z0-9-]{4,20})/i)
  const invDateMatch = text.match(/invoice\s*date\s*[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i)
  const dueDateMatch = text.match(/due\s*date\s*[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i)

  const subtotalMatch = text.match(/sub(?:total|[-\s]?total)\s*[:\s$]*([0-9,]+\.?\d{0,2})/i)
  const freightMatch  = text.match(/(?:freight|shipping)\s*[:\s$]*([0-9,]+\.?\d{0,2})/i)
  const taxMatch      = text.match(/(?:tax|sales tax)\s*[:\s$]*([0-9,]+\.?\d{0,2})/i)
  const totalMatch    = text.match(/(?:total\s*due|amount\s*due|invoice\s*total)\s*[:\s$]*([0-9,]+\.?\d{0,2})/i)

  const subtotal = subtotalMatch ? parseMoney(subtotalMatch[1]) : null
  const freight  = freightMatch  ? parseMoney(freightMatch[1])  : 0
  const tax      = taxMatch      ? parseMoney(taxMatch[1])       : 0
  const totalDue = totalMatch    ? parseMoney(totalMatch[1])     : (subtotal ? subtotal + freight + tax : null)

  // Credits: negative total or "(amount)" pattern
  const isCredit  = !!(text.match(/\([\d,]+\.\d{2}\)/) || (totalDue !== null && totalDue < 0))
  const isWarranty = !!(text.match(/warranty|no\s*charge|$0\.00/i) && totalDue === 0)

  // Line items: part# description qty unitprice linetotal
  const items = []
  const itemPattern = /([A-Z0-9-]{3,20})\s+([\w][^\n]{5,50}?)\s+(\d+)\s+\$?([\d,]+\.\d{2})\s+\$?([\d,]+\.\d{2})/g
  let m
  while ((m = itemPattern.exec(text)) !== null) {
    const unitPrice = parseMoney(m[4])
    const lineTotal = parseMoney(m[5])
    if (unitPrice > 0 || lineTotal > 0) {
      items.push({
        part_id:          m[1].trim(),
        description:      m[2].trim(),
        quantity_ordered: parseInt(m[3]),
        unit_price:       unitPrice,
        line_total:       lineTotal,
      })
    }
  }

  return {
    invoiceNumber: invMatch?.[1]?.trim() || null,
    salesOrder:    soMatch?.[1]?.trim()  || null,
    invoiceDate:   invDateMatch ? parseMMDDYYYY(invDateMatch[1]) : null,
    dueDate:       dueDateMatch ? parseMMDDYYYY(dueDateMatch[1]) : null,
    subtotal,
    freight,
    tax,
    totalDue,
    isCredit,
    isWarranty,
    items,
  }
}

/**
 * Parse E-BillExpress payment email body.
 * Returns { amount, salesOrder, paymentDate, creationDate, status, isBulk, memo }
 */
function parsePaymentEmail(subject, bodyText) {
  const text = bodyText.replace(/\s+/g, ' ')

  // Payment Amount
  const amtMatch = text.match(/payment\s*amount\s*[:\s$]+([0-9,]+\.?\d{0,2})/i)
  const amount   = amtMatch ? parseMoney(amtMatch[1]) : null

  // Sales Order — "Invoice Payment 12345678" or "for SO-12345678" or "Sales Order: 12345678"
  const soMatch =
    text.match(/invoice\s+payment\s+(?:for\s+)?([A-Z0-9-]{4,20})/i) ||
    text.match(/(?:sales\s*order|SO#?)\s*[:\s]+([A-Z0-9-]{4,20})/i) ||
    text.match(/reference\s*[:\s]+([A-Z0-9-]{4,20})/i)
  const salesOrder = soMatch?.[1]?.trim() || null

  // Dates
  const paymentDateMatch  = text.match(/payment\s*date\s*[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i)
  const creationDateMatch = text.match(/creation\s*date\s*[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i)

  // Status: "Payment Initiated" vs "Payment Posted"
  const statusMatch = text.match(/payment\s+(initiated|posted|processed|complete)/i)
  const status = statusMatch ? statusMatch[1].toLowerCase() : 'initiated'

  // Bulk payments: memo/subject mentions 'payment' or 'paying' generically
  const memoMatch = text.match(/(?:memo|description|note)\s*[:\s]+([^\n\r]{3,80})/i)
  const memo      = memoMatch?.[1]?.trim() || subject || null
  const isBulk    = !!(memo && /\b(?:payment|paying)\b/i.test(memo) && !salesOrder)

  return {
    amount,
    salesOrder,
    paymentDate:  paymentDateMatch  ? parseMMDDYYYY(paymentDateMatch[1])  : null,
    creationDate: creationDateMatch ? parseMMDDYYYY(creationDateMatch[1]) : null,
    status,
    isBulk,
    memo,
  }
}

// ── Parse helpers ─────────────────────────────────────────────────────────────

function parseMMDDYYYY(str) {
  if (!str) return null
  const parts = str.split(/[\/\-]/)
  if (parts.length !== 3) return null
  let [m, d, y] = parts.map(Number)
  if (y < 100) y += 2000
  if (isNaN(m + d + y)) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function parseMoney(str) {
  if (!str) return 0
  return parseFloat(String(str).replace(/,/g, '')) || 0
}

// ── Database helpers ──────────────────────────────────────────────────────────

async function upsertOrder(db, { orderNumber, orderDate, desiredShipDate, customerName, status = 'ordered', notes }) {
  if (!orderNumber) return null
  const r = await db.query(`
    INSERT INTO pentair_orders (order_number, order_date, desired_ship_date, customer_name, status, notes, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,NOW())
    ON CONFLICT (order_number) DO UPDATE
      SET order_date = EXCLUDED.order_date,
          desired_ship_date = COALESCE(EXCLUDED.desired_ship_date, pentair_orders.desired_ship_date),
          customer_name = COALESCE(EXCLUDED.customer_name, pentair_orders.customer_name),
          status = EXCLUDED.status,
          updated_at = NOW()
    RETURNING id
  `, [orderNumber, orderDate, desiredShipDate, customerName, status, notes])
  return r.rows[0]?.id
}

async function upsertOrderItems(db, orderId, items) {
  if (!orderId || !items?.length) return
  for (const item of items) {
    await db.query(`
      INSERT INTO pentair_order_items (order_id, part_id, description, quantity_ordered, quantity_shipped, unit_price, line_total)
      VALUES ($1,$2,$3,$4,0,$5,$6)
      ON CONFLICT DO NOTHING
    `, [orderId, item.part_id, item.description, item.quantity_ordered, item.unit_price, item.line_total])
  }
}

async function upsertShipment(db, { orderId, packlistNumber, trackingNumber, carrier, shipDate, emailId }) {
  if (!orderId) return
  // Avoid duplicates by tracking number
  const exists = trackingNumber
    ? await db.query('SELECT id FROM pentair_shipments WHERE tracking_number=$1', [trackingNumber])
    : { rows: [] }
  if (exists.rows.length) return
  await db.query(`
    INSERT INTO pentair_shipments (order_id, packlist_number, tracking_number, carrier, ship_date, email_id)
    VALUES ($1,$2,$3,$4,$5,$6)
  `, [orderId, packlistNumber, trackingNumber, carrier, shipDate, emailId])
}

async function upsertInvoice(db, {
  invoiceNumber, orderId, salesOrder, invoiceDate, dueDate,
  subtotal, freight, tax, totalDue, isCredit, isWarranty,
  emailId, pdfBuffer,
}) {
  if (!invoiceNumber) return null
  const discount = totalDue ? parseFloat((totalDue * 0.02).toFixed(2)) : null
  const net      = totalDue ? parseFloat((totalDue * 0.98).toFixed(2)) : null

  const r = await db.query(`
    INSERT INTO pentair_invoices
      (invoice_number, order_id, sales_order, invoice_date, due_date,
       subtotal, freight, tax, total_due, discount_2pct, net_after_discount,
       is_credit, is_warranty, email_id, pdf_content, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW())
    ON CONFLICT (invoice_number) DO UPDATE
      SET order_id = COALESCE(EXCLUDED.order_id, pentair_invoices.order_id),
          sales_order = COALESCE(EXCLUDED.sales_order, pentair_invoices.sales_order),
          invoice_date = COALESCE(EXCLUDED.invoice_date, pentair_invoices.invoice_date),
          due_date = COALESCE(EXCLUDED.due_date, pentair_invoices.due_date),
          subtotal = COALESCE(EXCLUDED.subtotal, pentair_invoices.subtotal),
          freight = COALESCE(EXCLUDED.freight, pentair_invoices.freight),
          tax = COALESCE(EXCLUDED.tax, pentair_invoices.tax),
          total_due = COALESCE(EXCLUDED.total_due, pentair_invoices.total_due),
          discount_2pct = COALESCE(EXCLUDED.discount_2pct, pentair_invoices.discount_2pct),
          net_after_discount = COALESCE(EXCLUDED.net_after_discount, pentair_invoices.net_after_discount),
          pdf_content = COALESCE(EXCLUDED.pdf_content, pentair_invoices.pdf_content),
          updated_at = NOW()
    RETURNING id
  `, [
    invoiceNumber, orderId, salesOrder, invoiceDate, dueDate,
    subtotal, freight, tax, totalDue, discount, net,
    isCredit, isWarranty, emailId, pdfBuffer,
  ])
  return r.rows[0]?.id
}

async function upsertPayment(db, {
  invoiceId, orderId, salesOrder, amount, paymentDate,
  creationDate, status, isBulk, memo, emailId,
}) {
  // Avoid re-inserting same email's payment
  if (emailId) {
    const exists = await db.query('SELECT id FROM pentair_payments WHERE email_id=$1', [emailId])
    if (exists.rows.length) return exists.rows[0].id
  }
  const r = await db.query(`
    INSERT INTO pentair_payments
      (invoice_id, order_id, sales_order, amount, payment_date, creation_date, status, is_bulk, memo, email_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING id
  `, [invoiceId, orderId, salesOrder, amount, paymentDate, creationDate, status, isBulk, memo, emailId])
  return r.rows[0]?.id
}

// ── Graph API helpers ─────────────────────────────────────────────────────────

const BASE = 'https://graph.microsoft.com/v1.0'

async function fetchFullMessage(token, mailbox, msgId) {
  const r = await fetch(
    `${BASE}/users/${mailbox}/messages/${msgId}?$select=id,subject,from,receivedDateTime,body,hasAttachments`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!r.ok) throw new Error(`Graph message ${r.status}`)
  return r.json()
}

async function fetchAttachments(token, mailbox, msgId) {
  const r = await fetch(
    `${BASE}/users/${mailbox}/messages/${msgId}/attachments`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!r.ok) return []
  const data = await r.json()
  return data.value || []
}

// ── Process individual Pentair emails ─────────────────────────────────────────

const recentActivity = []  // in-memory ring buffer for /stats endpoint

function logActivity(entry) {
  recentActivity.unshift({ ...entry, ts: new Date().toISOString() })
  if (recentActivity.length > 100) recentActivity.pop()
}

async function processPentairEmail(token, mailbox, msg) {
  const sender = msg.from?.emailAddress?.address?.toLowerCase()
  const subject = msg.subject || ''
  const db = getDb()

  const full = await fetchFullMessage(token, mailbox, msg.id)
  const body = full.body?.content || ''
  // Strip HTML tags for plain-text parsing
  const bodyText = body.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ')

  // ── cs.roselle@pentair.com: Order Acknowledgment OR Shipment Notice ──────
  if (sender === PENTAIR_CS) {
    const isShipment = /ship|packlist|tracking/i.test(subject)

    if (isShipment) {
      const parsed = parseShipmentNotice(subject, bodyText)
      console.log(`[pentair] Shipment notice: order=${parsed.orderNumber} tracking=${parsed.trackingNumber}`)

      // Find order
      let orderId = null
      if (parsed.orderNumber) {
        const r = await db.query('SELECT id FROM pentair_orders WHERE order_number=$1', [parsed.orderNumber])
        orderId = r.rows[0]?.id
        if (!orderId) {
          orderId = await upsertOrder(db, { orderNumber: parsed.orderNumber, status: 'shipped' })
        } else {
          await db.query('UPDATE pentair_orders SET status=$1, updated_at=NOW() WHERE id=$2',
            ['shipped', orderId])
        }
      }

      await upsertShipment(db, {
        orderId,
        packlistNumber: parsed.packlistNumber,
        trackingNumber: parsed.trackingNumber,
        carrier:        parsed.carrier,
        shipDate:       parsed.shipDate,
        emailId:        msg.id,
      })

      logActivity({ type: 'shipment', subject, tracking: parsed.trackingNumber, orderId })

    } else {
      // Order Acknowledgment
      const parsed = parseOrderAck(subject, bodyText)
      console.log(`[pentair] Order ack: order=${parsed.orderNumber} items=${parsed.items.length}`)

      const orderId = await upsertOrder(db, {
        orderNumber:    parsed.orderNumber,
        orderDate:      parsed.orderDate,
        desiredShipDate: parsed.desiredShipDate,
        customerName:   parsed.customerName,
        status:         'ordered',
      })
      await upsertOrderItems(db, orderId, parsed.items)

      logActivity({ type: 'order', subject, orderNumber: parsed.orderNumber, itemCount: parsed.items.length })
    }
  }

  // ── usro2_ar@pentair.com: Invoice email with PDF ───────────────────────────
  else if (sender === PENTAIR_AR) {
    let parsed = { invoiceNumber: null, salesOrder: null, items: [] }
    let pdfBuffer = null

    if (full.hasAttachments) {
      const attachments = await fetchAttachments(token, mailbox, msg.id)
      const pdf = attachments.find(a =>
        a.name?.toLowerCase().endsWith('.pdf') || a.contentType?.toLowerCase().includes('pdf')
      )
      if (pdf?.contentBytes) {
        pdfBuffer = Buffer.from(pdf.contentBytes, 'base64')
        const pdfText = await extractPdfText(pdfBuffer)
        if (pdfText) parsed = { ...parsed, ...parseInvoicePdf(pdfText) }
      }
    }

    // Fallback: try subject for invoice number
    if (!parsed.invoiceNumber) {
      const m = subject.match(/(?:invoice|inv)\s*#?\s*([A-Z0-9-]{4,20})/i)
      if (m) parsed.invoiceNumber = m[1].trim()
    }
    // Fallback: try body text for SO#
    if (!parsed.salesOrder) {
      const m = bodyText.match(/(?:sales\s*order|SO#?|order\s*#)\s*[:\s]+([A-Z0-9-]{4,20})/i)
      if (m) parsed.salesOrder = m[1].trim()
    }

    if (!parsed.invoiceNumber) {
      // Can't process without an invoice number — log and skip
      console.warn('[pentair] Invoice email missing invoice number, skipping:', subject)
      logActivity({ type: 'invoice_skip', subject, reason: 'no invoice number' })
      return
    }

    // Find matching order by sales order number
    let orderId = null
    if (parsed.salesOrder) {
      const r = await db.query(
        'SELECT id FROM pentair_orders WHERE order_number=$1', [parsed.salesOrder]
      )
      orderId = r.rows[0]?.id
    }

    const invoiceId = await upsertInvoice(db, {
      invoiceNumber: parsed.invoiceNumber,
      orderId,
      salesOrder:    parsed.salesOrder,
      invoiceDate:   parsed.invoiceDate,
      dueDate:       parsed.dueDate,
      subtotal:      parsed.subtotal,
      freight:       parsed.freight,
      tax:           parsed.tax,
      totalDue:      parsed.totalDue,
      isCredit:      parsed.isCredit,
      isWarranty:    parsed.isWarranty,
      emailId:       msg.id,
      pdfBuffer,
    })

    // Update order status to invoiced
    if (orderId) {
      await db.query(
        'UPDATE pentair_orders SET status=$1, updated_at=NOW() WHERE id=$2 AND status NOT IN ($3,$4)',
        ['invoiced', orderId, 'paid', 'partial']
      )
    }

    // Update invoice items if parsed from PDF
    if (parsed.items?.length && invoiceId) {
      // Get order items to update unit prices
      for (const item of parsed.items) {
        await db.query(`
          UPDATE pentair_order_items SET unit_price=$1, line_total=$2
          WHERE order_id=$3 AND part_id=$4 AND unit_price IS NULL
        `, [item.unit_price, item.line_total, orderId, item.part_id])
      }
    }

    console.log(`[pentair] Invoice: inv=${parsed.invoiceNumber} so=${parsed.salesOrder} total=${parsed.totalDue}`)
    logActivity({ type: 'invoice', subject, invoiceNumber: parsed.invoiceNumber, total: parsed.totalDue })
  }

  // ── E-BillExpress@E-billexpress.com: Payment email ─────────────────────────
  else if (sender === EBILL_EXPRESS) {
    const parsed = parsePaymentEmail(subject, bodyText)
    console.log(`[pentair] Payment: so=${parsed.salesOrder} amount=${parsed.amount} status=${parsed.status}`)

    // Find matching invoice by SO#
    let invoiceId = null
    let orderId = null
    if (parsed.salesOrder) {
      const r = await db.query(
        'SELECT id, order_id FROM pentair_invoices WHERE sales_order=$1 ORDER BY created_at DESC LIMIT 1',
        [parsed.salesOrder]
      )
      if (r.rows[0]) {
        invoiceId = r.rows[0].id
        orderId   = r.rows[0].order_id
      }
    }

    await upsertPayment(db, {
      invoiceId,
      orderId,
      salesOrder:   parsed.salesOrder,
      amount:       parsed.amount,
      paymentDate:  parsed.paymentDate,
      creationDate: parsed.creationDate,
      status:       parsed.status,
      isBulk:       parsed.isBulk,
      memo:         parsed.memo,
      emailId:      msg.id,
    })

    // Update order status
    if (orderId && parsed.status === 'posted') {
      await db.query(
        'UPDATE pentair_orders SET status=$1, updated_at=NOW() WHERE id=$2',
        ['paid', orderId]
      )
    }

    logActivity({ type: 'payment', subject, salesOrder: parsed.salesOrder, amount: parsed.amount })
  }
}

// ── Main poll function ────────────────────────────────────────────────────────

let pollerState = {
  running:     false,
  lastPoll:    null,
  lastError:   null,
  emailsFound: 0,
}

async function pollOnce() {
  const mailbox = process.env.MAILBOX_EMAIL
  if (!mailbox) return

  const token      = await getToken()
  const deltaToken = loadDeltaToken()
  const processed  = loadProcessed()

  let url = deltaToken
    ? `${BASE}/users/${mailbox}/mailFolders/Inbox/messages/delta?$deltaToken=${deltaToken}&$select=id,subject,from,hasAttachments,receivedDateTime`
    : `${BASE}/users/${mailbox}/mailFolders/Inbox/messages/delta?$select=id,subject,from,hasAttachments,receivedDateTime&$orderby=receivedDateTime+desc`

  const newMessages   = []
  let nextDeltaToken  = null

  while (url) {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
    if (!r.ok) throw new Error(`Graph delta ${r.status}: ${await r.text()}`)
    const data = await r.json()

    for (const msg of data.value || []) {
      const sender = msg.from?.emailAddress?.address?.toLowerCase()
      if (PENTAIR_SENDERS.has(sender) && !processed.has(msg.id)) {
        newMessages.push(msg)
      }
    }

    if (data['@odata.deltaLink']) {
      const match = data['@odata.deltaLink'].match(/\$deltaToken=([^&]+)/)
      if (match) nextDeltaToken = match[1]
      url = null
    } else {
      url = data['@odata.nextLink'] || null
    }
  }

  if (nextDeltaToken) saveDeltaToken(nextDeltaToken)

  console.log(`[pentair] Poll: ${newMessages.length} new Pentair email(s)`)

  for (const msg of newMessages) {
    processed.add(msg.id)
    saveProcessed(processed)
    pollerState.emailsFound++

    try {
      await processPentairEmail(token, mailbox, msg)
    } catch (err) {
      console.error('[pentair] Failed to process message:', msg.id, err.message)
      alert(`Pentair email processing failed: ${err.message} (subject: ${msg.subject})`)
    }
  }

  pollerState.lastPoll  = new Date().toISOString()
  pollerState.lastError = null
}

// ── Search-based backfill (no delta, searches last 90 days) ──────────────────

async function backfillFromSearch(token, mailbox, senderEmail, since = null, maxResults = 500) {
  const messages = []
  // Graph $search does not combine with $orderby — use search only, paginate
  let url = `https://graph.microsoft.com/v1.0/users/${mailbox}/messages?$search="from:${senderEmail}"&$top=50&$select=id,subject,from,hasAttachments,receivedDateTime`

  let pages = 0
  while (url && messages.length < maxResults && pages < 10) {
    const r = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, ConsistencyLevel: 'eventual' }
    })
    if (!r.ok) {
      const errText = await r.text().catch(() => '')
      console.error(`[pentair] backfill search failed for ${senderEmail}: ${r.status} ${errText.slice(0,200)}`)
      break
    }
    const data = await r.json()
    const filtered = (data.value || []).filter(m => {
      const addr = m.from?.emailAddress?.address?.toLowerCase()
      if (addr !== senderEmail.toLowerCase()) return false
      if (since && m.receivedDateTime < since) return false
      return true
    })
    messages.push(...filtered)
    url = data['@odata.nextLink'] || null
    pages++
    console.log(`[pentair] backfill ${senderEmail}: page ${pages}, ${messages.length} msgs so far`)
  }
  return messages
}

// ── Start/stop poller ─────────────────────────────────────────────────────────

let pollInterval = null

export function startPentairPoller() {
  if (pollInterval) return
  console.log(`[pentair] Starting Pentair email poller (every ${POLL_INTERVAL_MS / 60000} min)`)

  const run = async () => {
    pollerState.running = true
    try {
      await pollOnce()
    } catch (err) {
      pollerState.lastError = err.message
      console.error('[pentair] Poll failed:', err.message)
    } finally {
      pollerState.running = false
    }
  }

  run()
  pollInterval = setInterval(run, POLL_INTERVAL_MS)
}

export function stopPentairPoller() {
  if (pollInterval) {
    clearInterval(pollInterval)
    pollInterval = null
    console.log('[pentair] Poller stopped')
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

/** GET /api/pentair/orders — all orders with related data */
router.get('/pentair/orders', async (req, res) => {
  try {
    const db = getDb()
    const { month, status } = req.query

    let where = 'WHERE 1=1'
    const params = []
    if (month) {
      params.push(month)
      where += ` AND TO_CHAR(o.order_date,'YYYY-MM')=$${params.length}`
    }
    if (status) {
      params.push(status)
      where += ` AND o.status=$${params.length}`
    }

    const ordersR = await db.query(`
      SELECT o.*,
        COALESCE(json_agg(DISTINCT jsonb_build_object(
          'id', i.id, 'part_id', i.part_id, 'description', i.description,
          'quantity_ordered', i.quantity_ordered, 'quantity_shipped', i.quantity_shipped,
          'unit_price', i.unit_price, 'line_total', i.line_total
        )) FILTER (WHERE i.id IS NOT NULL), '[]') AS items,
        COALESCE(json_agg(DISTINCT jsonb_build_object(
          'id', s.id, 'packlist_number', s.packlist_number, 'tracking_number', s.tracking_number,
          'carrier', s.carrier, 'ship_date', s.ship_date
        )) FILTER (WHERE s.id IS NOT NULL), '[]') AS shipments,
        COALESCE(json_agg(DISTINCT jsonb_build_object(
          'id', inv.id, 'invoice_number', inv.invoice_number, 'invoice_date', inv.invoice_date,
          'total_due', inv.total_due, 'net_after_discount', inv.net_after_discount,
          'discount_2pct', inv.discount_2pct, 'is_credit', inv.is_credit, 'is_warranty', inv.is_warranty
        )) FILTER (WHERE inv.id IS NOT NULL), '[]') AS invoices,
        COALESCE(json_agg(DISTINCT jsonb_build_object(
          'id', p.id, 'amount', p.amount, 'payment_date', p.payment_date,
          'status', p.status, 'is_bulk', p.is_bulk
        )) FILTER (WHERE p.id IS NOT NULL), '[]') AS payments
      FROM pentair_orders o
      LEFT JOIN pentair_order_items i ON i.order_id = o.id
      LEFT JOIN pentair_shipments s ON s.order_id = o.id
      LEFT JOIN pentair_invoices inv ON inv.order_id = o.id
      LEFT JOIN pentair_payments p ON p.order_id = o.id
      ${where}
      GROUP BY o.id
      ORDER BY o.order_date DESC NULLS LAST
    `, params)

    res.json(ordersR.rows)
  } catch (err) {
    console.error('GET /api/pentair/orders:', err.message)
    res.status(500).json({ error: err.message })
  }
})

/** GET /api/pentair/invoices — all invoices with payment status */
router.get('/pentair/invoices', async (req, res) => {
  try {
    const db = getDb()
    const r = await db.query(`
      SELECT inv.*,
        o.order_number,
        COALESCE(json_agg(jsonb_build_object(
          'id', p.id, 'amount', p.amount, 'payment_date', p.payment_date, 'status', p.status
        )) FILTER (WHERE p.id IS NOT NULL), '[]') AS payments,
        COALESCE(SUM(p.amount) FILTER (WHERE p.status='posted'), 0) AS total_paid
      FROM pentair_invoices inv
      LEFT JOIN pentair_orders o ON o.id = inv.order_id
      LEFT JOIN pentair_payments p ON p.invoice_id = inv.id
      GROUP BY inv.id, o.order_number
      ORDER BY inv.invoice_date DESC NULLS LAST
    `)
    res.json(r.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/** GET /api/pentair/invoices/:id/pdf — serve stored PDF */
router.get('/pentair/invoices/:id/pdf', async (req, res) => {
  try {
    const db = getDb()
    const r = await db.query(
      'SELECT invoice_number, pdf_content FROM pentair_invoices WHERE id=$1',
      [req.params.id]
    )
    const row = r.rows[0]
    if (!row) return res.status(404).json({ error: 'Not found' })
    if (!row.pdf_content) return res.status(404).json({ error: 'No PDF stored' })
    res.set('Content-Type', 'application/pdf')
    res.set('Content-Disposition', `inline; filename="Invoice-${row.invoice_number}.pdf"`)
    res.send(row.pdf_content)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/** GET /api/pentair/payments — all payments */
router.get('/pentair/payments', async (req, res) => {
  try {
    const db = getDb()
    const r = await db.query(`
      SELECT p.*, inv.invoice_number, o.order_number
      FROM pentair_payments p
      LEFT JOIN pentair_invoices inv ON inv.id = p.invoice_id
      LEFT JOIN pentair_orders o ON o.id = p.order_id
      ORDER BY p.payment_date DESC NULLS LAST
    `)
    res.json(r.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/** GET /api/pentair/reconciliation — monthly summary */
router.get('/pentair/reconciliation', async (req, res) => {
  try {
    const db = getDb()
    const r = await db.query(`
      SELECT
        TO_CHAR(inv.invoice_date,'YYYY-MM') AS month,
        COUNT(DISTINCT inv.id)               AS invoice_count,
        SUM(inv.total_due)                   AS total_invoiced,
        SUM(inv.net_after_discount)          AS total_net,
        SUM(inv.discount_2pct)               AS total_discount,
        COALESCE(SUM(p.amount) FILTER (WHERE p.status='posted'), 0) AS total_paid,
        SUM(inv.total_due) - COALESCE(SUM(p.amount) FILTER (WHERE p.status='posted'), 0) AS outstanding
      FROM pentair_invoices inv
      LEFT JOIN pentair_payments p ON p.invoice_id = inv.id
      WHERE inv.invoice_date IS NOT NULL
        AND NOT inv.is_credit
      GROUP BY TO_CHAR(inv.invoice_date,'YYYY-MM')
      ORDER BY month DESC
    `)
    res.json(r.rows)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/** GET /api/pentair/stats — summary stats */
router.get('/pentair/stats', async (req, res) => {
  try {
    const db = getDb()
    const [statsR, activityR] = await Promise.all([
      db.query(`
        SELECT
          (SELECT COUNT(*) FROM pentair_orders) AS total_orders,
          (SELECT COALESCE(SUM(total_due),0) FROM pentair_invoices WHERE NOT is_credit AND NOT is_warranty) AS total_invoiced,
          (SELECT COALESCE(SUM(amount),0) FROM pentair_payments WHERE status='posted') AS total_paid,
          (SELECT COALESCE(SUM(discount_2pct),0) FROM pentair_invoices WHERE NOT is_credit AND NOT is_warranty) AS total_savings,
          (SELECT COUNT(*) FROM pentair_invoices WHERE NOT is_credit AND NOT is_warranty) AS total_invoices
      `),
      Promise.resolve(recentActivity.slice(0, 20)),
    ])
    const s = statsR.rows[0]
    res.json({
      totalOrders:    parseInt(s.total_orders),
      totalInvoices:  parseInt(s.total_invoices),
      totalInvoiced:  parseFloat(s.total_invoiced),
      totalPaid:      parseFloat(s.total_paid),
      outstanding:    parseFloat(s.total_invoiced) - parseFloat(s.total_paid),
      totalSavings:   parseFloat(s.total_savings),
      pollerActive:   !!pollInterval,
      lastPoll:       pollerState.lastPoll,
      lastError:      pollerState.lastError,
      recentActivity: activityR,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

/** POST /api/pentair/poll — manually trigger a poll */
router.post('/pentair/poll', async (req, res) => {
  try {
    await pollOnce()
    res.json({ ok: true, lastPoll: pollerState.lastPoll })
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message })
  }
})

/** POST /api/pentair/backfill — one-time backfill from last 90 days */
router.post('/pentair/backfill', async (req, res) => {
  try {
    const mailbox = process.env.MAILBOX_EMAIL
    if (!mailbox) return res.status(500).json({ error: 'MAILBOX_EMAIL not configured' })

    const since = req.body?.since || '2025-01-01T00:00:00Z'
    console.log(`[pentair] Starting backfill since ${since}`)

    const token    = await getToken()
    const processed = loadProcessed()
    const senders  = [PENTAIR_CS, PENTAIR_AR, EBILL_EXPRESS]

    let total = 0
    const errors = []
    const results = {}

    for (const sender of senders) {
      console.log(`[pentair] Backfilling ${sender}...`)
      const messages = await backfillFromSearch(token, mailbox, sender, since, 500)
      const newMsgs  = messages.filter(m => !processed.has(m.id))
      results[sender] = { found: messages.length, new: newMsgs.length }
      console.log(`[pentair] ${sender}: ${messages.length} found, ${newMsgs.length} new`)

      for (let i = 0; i < newMsgs.length; i++) {
        const msg = newMsgs[i]
        processed.add(msg.id)
        try {
          await processPentairEmail(token, mailbox, msg)
          total++
          // Rate-limit: pause briefly every message to avoid overwhelming free-tier DB
          if (i % 5 === 4) {
            await new Promise(r => setTimeout(r, 2000))
            saveProcessed(processed)
          }
        } catch (err) {
          console.error('[pentair] Backfill error:', msg.subject, err.message)
          errors.push({ subject: msg.subject, error: err.message })
          // On connection error, pause longer
          if (err.message.includes('Connection terminated') || err.message.includes('ECONNRESET')) {
            console.log('[pentair] DB connection issue, pausing 5s...')
            await new Promise(r => setTimeout(r, 5000))
          }
        }
      }
      saveProcessed(processed)
    }

    console.log(`[pentair] Backfill complete: ${total} processed`)
    res.json({ ok: true, processed: total, breakdown: results, errors: errors.slice(0, 20) })
  } catch (err) {
    console.error('[pentair] Backfill failed:', err.message)
    res.status(500).json({ ok: false, error: err.message })
  }
})

export default router
