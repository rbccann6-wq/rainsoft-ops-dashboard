import express from 'express'
import { ConfidentialClientApplication } from '@azure/msal-node'

const router = express.Router()

// ─── MSAL auth setup ─────────────────────────────────────────────────────────

let _msalClient = null
function getMsalClient() {
  if (!_msalClient) {
    _msalClient = new ConfidentialClientApplication({
      auth: {
        clientId: process.env.CLIENT_ID,
        clientSecret: process.env.CLIENT_SECRET,
        authority: `https://login.microsoftonline.com/${process.env.TENANT_ID}`,
      },
    })
  }
  return _msalClient
}

async function getAccessToken() {
  const result = await getMsalClient().acquireTokenByClientCredential({
    scopes: ['https://graph.microsoft.com/.default'],
  })
  if (!result?.accessToken) throw new Error('Failed to acquire access token')
  return result.accessToken
}

// ─── Graph API helper ────────────────────────────────────────────────────────

async function graphRequest(method, path, token, body = null) {
  const opts = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  }
  if (body) opts.body = JSON.stringify(body)

  const resp = await fetch(`https://graph.microsoft.com/v1.0${path}`, opts)

  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Graph ${method} ${path} → ${resp.status}: ${text}`)
  }
  if (resp.status === 204) return null
  return resp.json()
}

const MAILBOX = () => process.env.MAILBOX_EMAIL

// ─── Helpers ─────────────────────────────────────────────────────────────────

function stripHtml(html) {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\r\n|\r/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function formatTime(iso) {
  if (!iso) return ''
  const date = new Date(iso)
  const now = new Date()
  const diffDays = Math.floor((now - date) / 86400000)

  if (diffDays === 0) {
    return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  } else if (diffDays === 1) {
    return 'Yesterday'
  } else if (diffDays < 7) {
    return date.toLocaleDateString('en-US', { weekday: 'short' })
  } else {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
}

function mapMessage(msg, includeFullBody = false) {
  let body = msg.bodyPreview || ''
  if (includeFullBody && msg.body?.content) {
    body =
      msg.body.contentType === 'html'
        ? stripHtml(msg.body.content)
        : msg.body.content
  }
  return {
    id: msg.id,
    sender: msg.from?.emailAddress?.name || 'Unknown',
    senderEmail: msg.from?.emailAddress?.address || '',
    subject: msg.subject || '(No Subject)',
    preview: msg.bodyPreview || '',
    body,
    time: formatTime(msg.receivedDateTime),
    isRead: msg.isRead,
    hasAttachment: msg.hasAttachments || false,
    threadId: msg.conversationId,
  }
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// GET /api/emails — all inbox emails, paginated
// Query params: ?top=200&skip=0&unreadOnly=false
router.get('/emails', async (req, res) => {
  try {
    const token = await getAccessToken()
    const mailbox = MAILBOX()
    const top = Math.min(parseInt(req.query.top) || 200, 500)
    const skip = parseInt(req.query.skip) || 0
    const unreadOnly = req.query.unreadOnly === 'true'

    const params = {
      $top: String(top),
      $skip: String(skip),
      $select: 'id,subject,from,receivedDateTime,bodyPreview,isRead,hasAttachments,conversationId',
      $orderby: 'receivedDateTime desc',
    }
    if (unreadOnly) params['$filter'] = 'isRead eq false'

    const qs = new URLSearchParams(params)
    const data = await graphRequest('GET', `/users/${mailbox}/messages?${qs}`, token)
    res.json({
      emails: (data.value || []).map((m) => mapMessage(m)),
      nextSkip: skip + top,
      hasMore: (data.value || []).length === top,
    })
  } catch (err) {
    console.error('GET /api/emails:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// GET /api/emails/:id — full email body
router.get('/emails/:id', async (req, res) => {
  try {
    const token = await getAccessToken()
    const qs = new URLSearchParams({
      $select: 'id,subject,from,receivedDateTime,body,bodyPreview,isRead,hasAttachments,conversationId',
    })
    const msg = await graphRequest(
      'GET',
      `/users/${MAILBOX()}/messages/${req.params.id}?${qs}`,
      token,
    )
    res.json(mapMessage(msg, true))
  } catch (err) {
    console.error(`GET /api/emails/${req.params.id}:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/emails/:id/draft-reply — create draft in M365, does NOT send
router.post('/emails/:id/draft-reply', async (req, res) => {
  try {
    const { body: replyBody } = req.body
    if (!replyBody) return res.status(400).json({ error: 'body is required' })

    const token = await getAccessToken()
    const mailbox = MAILBOX()

    // Create the reply draft in the Drafts folder
    const draft = await graphRequest(
      'POST',
      `/users/${mailbox}/messages/${req.params.id}/createReply`,
      token,
    )

    // Replace auto-generated body with the user's actual reply
    await graphRequest('PATCH', `/users/${mailbox}/messages/${draft.id}`, token, {
      body: { contentType: 'Text', content: replyBody },
    })

    res.json({ draftId: draft.id })
  } catch (err) {
    console.error(`POST /api/emails/${req.params.id}/draft-reply:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

// POST /api/emails/:id/send-reply — send an approved draft (explicit action only)
router.post('/emails/:id/send-reply', async (req, res) => {
  try {
    const token = await getAccessToken()
    await graphRequest(
      'POST',
      `/users/${MAILBOX()}/messages/${req.params.id}/send`,
      token,
    )
    res.json({ success: true })
  } catch (err) {
    console.error(`POST /api/emails/${req.params.id}/send-reply:`, err.message)
    res.status(500).json({ error: err.message })
  }
})

export default router
