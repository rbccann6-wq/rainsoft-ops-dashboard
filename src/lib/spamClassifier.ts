import type { Email } from '@/types'

// ─── Dynamic safelist (loaded from server) ───────────────────────────────────
let dynamicSafeEmails: Set<string> = new Set()
let dynamicSafeDomains: Set<string> = new Set()

export async function loadDynamicSafelist() {
  try {
    const resp = await fetch('/api/safelist')
    if (resp.ok) {
      const data = await resp.json()
      dynamicSafeEmails = new Set((data.emails ?? []).map((e: string) => e.toLowerCase()))
      dynamicSafeDomains = new Set((data.domains ?? []).map((d: string) => d.toLowerCase()))
    }
  } catch { /* fail silently — static list still applies */ }
}

// ─── NEVER touch these — always keep in inbox ────────────────────────────────
const SAFE_DOMAINS = new Set([
  'rainsoftse.com', 'rainsoft.com', 'pentair.com', 'dialpad.com',
  'salesforce.com', 'docusign.net', 'docusign.com', 'fastfieldforms.com',
  'rippling.com', 'loweshomeservices.com', 'imeinc.com', 'trustedhomeservices.com',
  'homedepot.com', 'smartmailgroup.com', 'microsoft.com', 'microsoftonline.com',
  'aflac.com', 'accounts.google.com', 'wellsfargo.com', 'americanexpress.com',
  'welcome.americanexpress.com', 'squareup.com', 'legal.squareup.com',
  'notify.wellsfargo.com', 'accountprotection.microsoft.com',
])

const SAFE_SENDER_FRAGMENTS = [
  'rainsoftse.com', 'rainsoft.com', '@pentair.com', '@dialpad.com',
  '@salesforce.com', '@docusign', '@rippling.com', '@aflac.com',
  '@fastfieldforms.com', 'home_services_no_reply@homedepot.com',
  'do-not-reply@email.loweshomeservices.com', '@accounts.google.com',
]

// ─── Definite spam ────────────────────────────────────────────────────────────
const SPAM_DOMAINS = new Set([
  'americangirl.com', 'tradingcheatsheet.com', 'email.drinkcirkul.com',
  'newsletters.fubo.tv', 'm.coincraziness.com', 'decisionlender.solutions',
  'e2.vspink.com', 'goodmorningalerts.com', 'helpfullyftcapital.com',
  'm.seaworldparks.com', 'wonderfold.com', 'promotion.overstock.com',
  'mail.vistaprint.com', 'mail.zillow.com', 'aquatica.com',
  'mc.siriusxm.com', 'email.shoestation.com', 'shopifyemail.com',
  'email.simplisafe.com', 'mail.vctrainings.com',
])

const SPAM_SUBJECT_KEYWORDS = [
  'unsubscribe', '% off', 'deal ends', 'last call', 'final hours',
  'free gift', 'act now', 'limited time', 'exclusive offer', 'dont miss',
  'you won', 'selected as', 'congratulations', 'click here', 'earn money',
  'make money', 'stock alert', 'crypto', 'ai bubble', 'gold shock',
  'weight loss', 'burn fat', 'get rich', 'work from home',
]

function getDomain(email: string): string {
  return email.split('@')[1]?.toLowerCase() ?? ''
}

function isSafe(email: Email): boolean {
  const addr = email.senderEmail.toLowerCase()
  const domain = getDomain(addr)
  // Exact domain match
  if (SAFE_DOMAINS.has(domain)) return true
  // Subdomain match — e.g. mail.rainsoftse.com should be protected same as rainsoftse.com
  for (const safeDomain of SAFE_DOMAINS) {
    if (domain.endsWith('.' + safeDomain)) return true
  }
  if (dynamicSafeEmails.has(addr)) return true
  if (dynamicSafeDomains.has(domain)) return true
  return SAFE_SENDER_FRAGMENTS.some(f => addr.includes(f))
}

function isSpam(email: Email): boolean {
  const domain = getDomain(email.senderEmail)
  if (SPAM_DOMAINS.has(domain)) return true
  const subj = email.subject.toLowerCase()
  return SPAM_SUBJECT_KEYWORDS.some(kw => subj.includes(kw))
}

export type EmailCategory = 'inbox' | 'spam-review'

export function classifyEmail(email: Email): EmailCategory {
  if (isSafe(email)) return 'inbox'
  if (isSpam(email)) return 'spam-review'
  return 'inbox' // when in doubt, keep in inbox
}

export function classifyAll(emails: Email[]): {
  inbox: Email[]
  spamReview: Email[]
} {
  const inbox: Email[] = []
  const spamReview: Email[] = []
  for (const e of emails) {
    if (classifyEmail(e) === 'spam-review') spamReview.push(e)
    else inbox.push(e)
  }
  return { inbox, spamReview }
}
