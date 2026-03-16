import type { Email } from '@/types'

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
  const domain = getDomain(email.senderEmail)
  if (SAFE_DOMAINS.has(domain)) return true
  return SAFE_SENDER_FRAGMENTS.some(f => email.senderEmail.toLowerCase().includes(f))
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
