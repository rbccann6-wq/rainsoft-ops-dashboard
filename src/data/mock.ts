import type {
  Email,
  Agent,
  SocialPost,
  GoogleAdsSpend,
  ResearchTask,
  QuickStats,
} from '@/types'

// ─── Emails ──────────────────────────────────────────────────────────────────

export const mockEmails: Email[] = [
  {
    id: 'e1',
    sender: 'James Whitfield',
    senderEmail: 'j.whitfield@dothanwater.gov',
    subject: 'Water Quality Report – March Compliance',
    preview: 'Please find attached our Q1 compliance report. We noticed elevated hardness...',
    body: `James here from Dothan Municipal Water. Please find attached our Q1 compliance report for your review.

We noticed elevated hardness levels (18 GPG) in the northwest district this month and wanted to discuss whether your RainSoft EC4 OnyX systems would be appropriate for residential customers in that area.

We're also interested in your bulk pricing for the HydroLink Smart controllers. Could you send us a quote for 25 units?

Thanks,
James Whitfield
Water Quality Manager
Dothan Municipal Water Authority`,
    time: '9:14 AM',
    isRead: false,
    hasAttachment: true,
  },
  {
    id: 'e2',
    sender: 'Sandra Okafor',
    senderEmail: 'sandra@okaforhomes.com',
    subject: 'Re: Installation Quote for 4-bedroom Home',
    preview: 'Hi, thanks for the quote. My husband and I reviewed it and we have a few questions...',
    body: `Hi,

Thanks for the quote you sent over last week. My husband and I reviewed it and we have a few questions before we move forward.

1. Does the installation price include the brine tank setup?
2. What's the warranty on the softener unit itself vs. the labor?
3. Can we finance through RainSoft directly or do we need to use a third party?

We're very interested — the water here on Honeysuckle Lane has been terrible since we moved in. The dishes have white spots and the showerheads clog every few months.

Looking forward to your response!

Sandra Okafor`,
    time: '8:47 AM',
    isRead: false,
  },
  {
    id: 'e3',
    sender: 'Derek Holt',
    senderEmail: 'd.holt@holtplumbing.net',
    subject: 'Partnership Opportunity – Referral Program',
    preview: 'Hey, been following RainSoft for a while. I run a plumbing company out of Enterprise...',
    body: `Hey team,

Been following RainSoft of the Wiregrass for a while now. I run a plumbing company out of Enterprise — Holt Plumbing & Mechanical — and I think there's a great opportunity for a referral partnership.

We handle 30–40 residential jobs a month and water quality complaints come up constantly. I'd love to refer customers your way and work out a mutually beneficial arrangement.

Would you be open to a call this week? I'm free Thursday afternoon or Friday morning.

Derek Holt
Owner, Holt Plumbing & Mechanical
Enterprise, AL`,
    time: 'Yesterday',
    isRead: true,
  },
  {
    id: 'e4',
    sender: 'Carolyn Brewster',
    senderEmail: 'cbrewster@rainsoft.com',
    subject: 'Q1 Sales Targets – Regional Update',
    preview: 'Hope everyone is doing well. Attaching Q1 regional targets. Alabama Southeast...',
    body: `Hi team,

Hope everyone is doing well. Please find attached the Q1 regional sales targets from corporate.

Alabama Southeast has a stretch goal of 48 new residential installations this quarter. We're currently at 31, so there's a solid runway ahead. Focus areas:

• Enterprise / Coffee County – underserved market
• Ozark – growing residential development
• Eufaula – strong lead pipeline from the home show

Let me know if you have questions on territory breakdowns.

Carolyn Brewster
Regional Sales Manager
RainSoft – Southeast Region`,
    time: 'Yesterday',
    isRead: true,
    hasAttachment: true,
  },
  {
    id: 'e5',
    sender: 'Mike Travers',
    senderEmail: 'mike.travers@propertymgmt.com',
    subject: 'Service Request – 12 Units at Magnolia Crossing',
    preview: 'We have 12 units at Magnolia Crossing Apartments that need softener service...',
    body: `Hello,

We manage Magnolia Crossing Apartments on Ross Clark Circle and have 12 units with aging water softener systems that need evaluation and likely replacement.

These are original installations from around 2014. Several tenants have complained about salt bridges and decreased performance. We'd like someone to come out and assess the full property.

Is there availability next week? Tuesday or Wednesday works best for our maintenance schedule.

Mike Travers
Director of Operations
Travers Property Management Group`,
    time: 'Mon',
    isRead: true,
  },
  {
    id: 'e6',
    sender: 'Lena Dumont',
    senderEmail: 'lena.d@gmail.com',
    subject: 'Spotted your truck — question about well water',
    preview: 'Hi! I saw your truck at my neighbor\'s house and had to reach out. We\'re on well water...',
    body: `Hi there!

I saw your truck at my neighbor's house on Ridgecrest Drive last week and I just had to reach out. We've been on well water for 8 years and the iron staining in our sinks and tubs is absolutely awful.

I've tried the off-the-shelf solutions but nothing works. Does RainSoft have something specific for iron removal? Also, do you do free water tests?

Thanks so much,
Lena Dumont`,
    time: 'Mon',
    isRead: false,
  },
]

// ─── Agents ──────────────────────────────────────────────────────────────────

export const mockAgents: Agent[] = [
  {
    id: 'rex',
    name: 'Rex',
    role: 'Orchestrator',
    emoji: '👑',
    status: 'active',
    lastTask: 'Coordinated morning briefing, dispatched Scout to research Dothan market data',
    lastTaskTime: '9:02 AM',
    tasksToday: 14,
  },
  {
    id: 'forge',
    name: 'Forge',
    role: 'Coding',
    emoji: '💻',
    status: 'working',
    lastTask: 'Building Ops Dashboard — React + TypeScript + Vite',
    lastTaskTime: '9:15 AM',
    tasksToday: 3,
  },
  {
    id: 'amp',
    name: 'Amp',
    role: 'Marketing',
    emoji: '📣',
    status: 'idle',
    lastTask: 'Drafted Facebook post on spring water testing promotion',
    lastTaskTime: '8:30 AM',
    tasksToday: 5,
  },
  {
    id: 'scout',
    name: 'Scout',
    role: 'Research',
    emoji: '🔬',
    status: 'working',
    lastTask: 'Analyzing Dothan metro water quality trends and competitor pricing',
    lastTaskTime: '9:10 AM',
    tasksToday: 7,
  },
  {
    id: 'inbox',
    name: 'Inbox',
    role: 'Email',
    emoji: '📬',
    status: 'idle',
    lastTask: 'Processed 6 incoming emails, flagged 3 for priority response',
    lastTaskTime: '9:00 AM',
    tasksToday: 12,
  },
]

// ─── Social Posts ─────────────────────────────────────────────────────────────

export const mockSocialPosts: SocialPost[] = [
  {
    id: 'p1',
    platform: 'Facebook',
    content:
      '🌊 Spring is here — is your water ready? Hard water can wreak havoc on your appliances, pipes, and skin. Schedule your FREE water test today and see what\'s really coming out of your tap. #RainSoft #WirегrassWater #CleanWater',
    scheduledTime: 'Today, 11:00 AM',
    status: 'scheduled',
    engagementHint: 'Best time for Wiregrass audience',
  },
  {
    id: 'p2',
    platform: 'TikTok',
    content:
      'POV: You just got your RainSoft system installed and turned on the shower 🚿✨ No more white residue. No more dry skin. Just clean, soft water. Comment "WATER" for a free test! #WaterSoftener #CleanWater #HomeImprovement #Dothan',
    scheduledTime: 'Today, 3:00 PM',
    status: 'scheduled',
    engagementHint: 'Trending home improvement slot',
  },
  {
    id: 'p3',
    platform: 'Facebook',
    content:
      'Did you know Alabama ranks in the top 10 states for hard water? If you\'re seeing scale buildup on faucets or spots on dishes, your water is working against you. We can fix that. 💧 Call us or drop your zip code below!',
    scheduledTime: 'Tomorrow, 9:00 AM',
    status: 'draft',
  },
  {
    id: 'p4',
    platform: 'TikTok',
    content:
      'We tested the water at a local Dothan home — the results were shocking 😳 18 grains per gallon of hardness, iron staining, and chlorine taste. Watch what happens AFTER our system is installed. Full video this Friday! #WaterTest #RainSoft',
    scheduledTime: 'Wed, Mar 18 · 5:00 PM',
    status: 'draft',
  },
  {
    id: 'p5',
    platform: 'Facebook',
    content:
      'Thank you to the Johnson family in Enterprise for trusting RainSoft of the Wiregrass with their home! 🏡 They were dealing with iron staining for years. One installation later — spotless sinks, softer laundry, and better-tasting water.',
    scheduledTime: 'Mar 15, 10:00 AM',
    status: 'posted',
    engagementHint: '142 likes · 23 shares',
  },
  {
    id: 'p6',
    platform: 'Instagram',
    content:
      'Before & after: iron staining removed, fixtures restored ✨ Your home deserves better water. Link in bio for a free water test.',
    scheduledTime: 'Mar 14, 2:00 PM',
    status: 'posted',
    engagementHint: '89 likes',
  },
]

// ─── Google Ads ───────────────────────────────────────────────────────────────

export const mockGoogleAdsSpend: GoogleAdsSpend = {
  dailySpend: 4.17,
  monthlySpend: 61.82,
  monthlyBudget: 100,
  dailyBudget: 3.33,
  lastUpdated: '9:05 AM today',
  campaigns: [
    {
      id: 'c1',
      name: 'Water Softener – Dothan',
      spend: 28.40,
      clicks: 94,
      impressions: 2140,
      status: 'active',
    },
    {
      id: 'c2',
      name: 'Iron Removal – Wiregrass',
      spend: 18.67,
      clicks: 61,
      impressions: 1380,
      status: 'active',
    },
    {
      id: 'c3',
      name: 'Free Water Test – Brand',
      spend: 14.75,
      clicks: 52,
      impressions: 980,
      status: 'active',
    },
  ],
}

// ─── Research Tasks ───────────────────────────────────────────────────────────

export const mockResearchTasks: ResearchTask[] = [
  {
    id: 'r1',
    topic: 'Dothan Metro Hard Water Trends 2025',
    summary:
      'Dothan metro area averages 16–19 GPG hardness. Municipal supply from Chattahoochee River shows seasonal variation. 73% of sampled homes exceed EPA secondary standards for hardness. Key competitor pricing 8–12% above our current rates.',
    dateCompleted: 'Today, 8:45 AM',
    status: 'completed',
    sources: 7,
    tags: ['water quality', 'market research', 'Dothan'],
  },
  {
    id: 'r2',
    topic: 'Competitor Analysis – Southeast Alabama Water Treatment',
      summary:
      'Identified 4 active competitors in 60-mile radius. Culligan Dothan leads on brand recognition but has 3.2★ Google rating vs our 4.8★. EcoWater Enterprise has aggressive pricing (-15%) but limited service area. Kinetico has no local presence.',
    dateCompleted: 'Mar 15, 2:30 PM',
    status: 'completed',
    sources: 12,
    tags: ['competitors', 'pricing', 'market'],
  },
  {
    id: 'r3',
    topic: 'TikTok Content Strategy – Home Services Q2 2025',
    summary:
      'Before/after content driving 3.2x higher engagement than product-only posts. Optimal post times: 7–9 AM, 12–1 PM, 7–9 PM CT. "Water test reveal" format performing exceptionally — 180% above category average. Recommend 3x/week cadence.',
    dateCompleted: 'Mar 14, 11:00 AM',
    status: 'completed',
    sources: 5,
    tags: ['social media', 'TikTok', 'content strategy'],
  },
  {
    id: 'r4',
    topic: 'Alabama Residential Well Water Regulations 2025',
    summary:
      'Alabama ADEM updated well water testing requirements in Jan 2025. Private wells not subject to EPA SDWA but county health departments increasingly recommending annual iron/arsenic testing. Opportunity to position as trusted testing partner.',
    dateCompleted: 'Mar 13, 4:00 PM',
    status: 'completed',
    sources: 9,
    tags: ['regulations', 'well water', 'Alabama'],
  },
  {
    id: 'r5',
    topic: 'Google Ads Keyword Optimization – March 2025',
    summary:
      'Analysis in progress. Reviewing search term reports for Q1. Initial findings show "water softener rental" and "iron filter Dothan" as underutilized high-intent terms. CPC trending down 7% vs Q4.',
    dateCompleted: 'In progress',
    status: 'in-progress',
    sources: 3,
    tags: ['Google Ads', 'keywords', 'PPC'],
  },
]

// ─── Quick Stats ──────────────────────────────────────────────────────────────

export const mockQuickStats: QuickStats = {
  unreadEmails: mockEmails.filter((e) => !e.isRead).length,
  pendingPosts: mockSocialPosts.filter((p) => p.status === 'draft' || p.status === 'scheduled').length,
  googleAdsSpend: mockGoogleAdsSpend.monthlySpend,
  googleAdsBudget: mockGoogleAdsSpend.monthlyBudget,
  activeAgents: mockAgents.filter((a) => a.status === 'active' || a.status === 'working').length,
}
