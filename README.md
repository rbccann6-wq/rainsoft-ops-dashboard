# RainSoft of the Wiregrass — Ops Dashboard

Internal operations dashboard for RainSoft of the Wiregrass. Built with React 18, TypeScript, Vite, and Tailwind CSS.

## Features

- **Email Dashboard** — Microsoft 365 inbox, draft reply workflow, approve & send
- **Agent Status Panel** — Live status of Rex, Forge, Amp, Scout, and Inbox agents
- **Marketing Hub** — Social post queue (Facebook/TikTok/Instagram) + Google Ads spend tracker with $100/mo hard cap enforcement
- **Research Feed** — Scout research task queue and results
- **Overview** — Quick-glance dashboard with all key metrics

---

## Setup

### Prerequisites

- Node.js 20+
- npm 9+

### Install & Run

```bash
git clone <repo-url>
cd ops-dashboard
npm install
npm run dev
```

App runs at `http://localhost:5173`

### Build for Production

```bash
npm run build
# Output in ./dist
```

---

## Deployment (Render)

This repo includes a `render.yaml` for [Render](https://render.com) static site deployment.

1. Push repo to GitHub
2. Create a new Static Site on Render → connect repo
3. Render auto-detects `render.yaml` — no manual config needed
4. Set any required environment variables in the Render dashboard (see below)

---

## Environment Variables

The current app uses mock data. When connecting real APIs, add these to your `.env` (and Render dashboard):

| Variable | Description |
|---|---|
| `VITE_M365_TENANT_ID` | Microsoft 365 tenant ID |
| `VITE_M365_CLIENT_ID` | Microsoft 365 app client ID |
| `VITE_META_ACCESS_TOKEN` | Meta (Facebook/Instagram) long-lived access token |
| `VITE_GOOGLE_ADS_CUSTOMER_ID` | Google Ads customer ID |
| `VITE_CRM_BASE_URL` | Base URL of the Lovable-built CRM API |
| `VITE_CRM_API_KEY` | API key for CRM integration |

> All env vars must be prefixed with `VITE_` to be accessible in the browser bundle.

---

## Plugging in Real APIs

### Microsoft 365 Email (Graph API)

Replace mock data in `src/data/mock.ts` with calls to the [Microsoft Graph API](https://learn.microsoft.com/en-us/graph/api/user-list-messages).

```ts
// src/api/email.ts
const BASE = 'https://graph.microsoft.com/v1.0/me'

export async function fetchInbox(accessToken: string) {
  const res = await fetch(`${BASE}/mailFolders/inbox/messages?$top=25&$orderby=receivedDateTime desc`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  return res.json()
}

export async function sendMessage(accessToken: string, message: object) {
  return fetch(`${BASE}/sendMail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ message }),
  })
}
```

Auth: Use [MSAL.js](https://github.com/AzureAD/microsoft-authentication-library-for-js) with scopes `Mail.Read`, `Mail.Send`.

---

### Meta API (Facebook / Instagram)

```ts
// src/api/social.ts
const GRAPH = 'https://graph.facebook.com/v19.0'

export async function scheduleFBPost(pageId: string, content: string, publishTime: string) {
  const params = new URLSearchParams({
    message: content,
    published: 'false',
    scheduled_publish_time: String(Math.floor(new Date(publishTime).getTime() / 1000)),
    access_token: import.meta.env.VITE_META_ACCESS_TOKEN,
  })
  return fetch(`${GRAPH}/${pageId}/feed`, { method: 'POST', body: params })
}
```

Required permissions: `pages_manage_posts`, `pages_read_engagement`.

---

### Google Ads API

```ts
// src/api/googleAds.ts
// Use the Google Ads REST API or the google-ads-api npm package
// Endpoint: https://googleads.googleapis.com/v16/customers/{customerId}/googleAds:search

export async function fetchMonthlySpend(accessToken: string, customerId: string) {
  const query = `
    SELECT campaign.name, metrics.cost_micros
    FROM campaign
    WHERE segments.date DURING THIS_MONTH
  `
  const res = await fetch(
    `https://googleads.googleapis.com/v16/customers/${customerId}/googleAds:search`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'developer-token': import.meta.env.VITE_GOOGLE_ADS_DEVELOPER_TOKEN,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    }
  )
  return res.json()
}
```

> **Hard cap enforcement**: The `$100/mo` cap is visually enforced in the UI. For automatic spend halts, set a budget cap directly in Google Ads campaign settings as a secondary safeguard.

---

### CRM Integration (Lovable)

The types in `src/types/index.ts` include `CRMContact` and `ApiConfig` interfaces designed for the Lovable CRM. When the CRM exposes an API:

```ts
// src/api/crm.ts
const BASE = import.meta.env.VITE_CRM_BASE_URL

export async function fetchContacts(): Promise<CRMContact[]> {
  const res = await fetch(`${BASE}/contacts`, {
    headers: { 'x-api-key': import.meta.env.VITE_CRM_API_KEY },
  })
  return res.json()
}
```

The email `senderEmail` field is designed to be matched against CRM contacts for lead enrichment.

---

## Project Structure

```
src/
├── components/
│   ├── agents/       # AgentStatusPanel
│   ├── email/        # EmailDashboard
│   ├── layout/       # Header, Sidebar
│   ├── marketing/    # MarketingHub
│   ├── research/     # ResearchFeed
│   └── ui/           # Badge, Button, Card, Modal, ProgressBar
├── data/
│   └── mock.ts       # All mock data — replace with real API calls
├── lib/
│   └── utils.ts      # cn() utility
├── pages/
│   └── OverviewPage.tsx
└── types/
    └── index.ts      # All TypeScript interfaces
```

---

## Tech Stack

- **React 18** + **TypeScript** + **Vite 8**
- **Tailwind CSS v4**
- **React Router v6**
- **Lucide React** (icons)

---

*Built by Forge — RainSoft of the Wiregrass AI Engineering Agent*
