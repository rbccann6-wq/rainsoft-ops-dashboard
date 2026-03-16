// ─── Email ───────────────────────────────────────────────────────────────────

export interface Email {
  id: string
  sender: string
  senderEmail: string
  subject: string
  preview: string
  body: string
  time: string
  isRead: boolean
  hasAttachment?: boolean
  threadId?: string
}

export interface EmailDraft {
  id: string
  to: string
  subject: string
  body: string
  inReplyTo?: string
  graphDraftId?: string
  status: 'draft' | 'approved' | 'sent'
  createdAt: string
}

// ─── Agents ──────────────────────────────────────────────────────────────────

export type AgentStatus = 'active' | 'idle' | 'working'

export interface Agent {
  id: string
  name: string
  role: string
  emoji: string
  status: AgentStatus
  lastTask: string
  lastTaskTime: string
  tasksToday: number
}

// ─── Marketing ───────────────────────────────────────────────────────────────

export type SocialPlatform = 'Facebook' | 'TikTok' | 'Instagram'
export type PostStatus = 'draft' | 'scheduled' | 'posted' | 'failed'

export interface SocialPost {
  id: string
  platform: SocialPlatform
  content: string
  scheduledTime: string
  status: PostStatus
  imageUrl?: string
  engagementHint?: string
}

export interface GoogleAdsSpend {
  dailySpend: number
  monthlySpend: number
  monthlyBudget: number
  dailyBudget: number
  lastUpdated: string
  campaigns: AdsCampaign[]
}

export interface AdsCampaign {
  id: string
  name: string
  spend: number
  clicks: number
  impressions: number
  status: 'active' | 'paused'
}

// ─── Research ────────────────────────────────────────────────────────────────

export type ResearchStatus = 'pending' | 'in-progress' | 'completed'

export interface ResearchTask {
  id: string
  topic: string
  summary: string
  dateCompleted: string
  status: ResearchStatus
  sources: number
  tags: string[]
}

// ─── Dashboard Quick Stats ────────────────────────────────────────────────────

export interface QuickStats {
  unreadEmails: number
  pendingPosts: number
  googleAdsSpend: number
  googleAdsBudget: number
  activeAgents: number
}

// ─── Leads ───────────────────────────────────────────────────────────────────

export interface ImeLead {
  woId: string
  customerName: string
  phone: string
  officePhone: string
  email: string
  address: string
  store: string
  status: string
  emailDate: string
  emailId: string
  contacted?: boolean
}

export interface SmartMailBatch {
  emailId: string
  subject: string
  date: string
  status: 'pdf_ready' | 'processing' | 'done' | 'error'
}

// ─── API Hook Types (for future CRM integration) ─────────────────────────────

export interface CRMContact {
  id: string
  name: string
  email: string
  phone?: string
  status: 'lead' | 'customer' | 'prospect'
}

export interface ApiConfig {
  m365TenantId?: string
  m365ClientId?: string
  metaAccessToken?: string
  googleAdsCustomerId?: string
  crmBaseUrl?: string
}
