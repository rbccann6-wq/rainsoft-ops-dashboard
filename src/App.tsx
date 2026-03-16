import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { Header } from '@/components/layout/Header'
import { Sidebar } from '@/components/layout/Sidebar'
import { OverviewPage } from '@/pages/OverviewPage'
import { EmailDashboard } from '@/components/email/EmailDashboard'
import { AgentStatusPanel } from '@/components/agents/AgentStatusPanel'
import { MarketingHub } from '@/components/marketing/MarketingHub'
import { ResearchFeed } from '@/components/research/ResearchFeed'
import { LeadsPanel } from '@/components/leads/LeadsPanel'
import { BillsTracker } from '@/components/bills/BillsTracker'
import { EmailCleaner } from '@/components/cleaner/EmailCleaner'
import { mockQuickStats } from '@/data/mock'

export default function App() {
  return (
    <BrowserRouter>
      <div className="flex flex-col min-h-screen bg-[#0a0a0f]">
        <Header stats={mockQuickStats} />
        <div className="flex flex-1 overflow-hidden">
          <Sidebar />
          <main className="flex-1 overflow-y-auto p-5 lg:p-7">
            <Routes>
              <Route path="/" element={<OverviewPage />} />
              <Route path="/email" element={<EmailDashboard />} />
              <Route path="/agents" element={<AgentStatusPanel />} />
              <Route path="/marketing" element={<MarketingHub />} />
              <Route path="/research" element={<ResearchFeed />} />
              <Route path="/leads" element={<LeadsPanel />} />
              <Route path="/bills" element={<BillsTracker />} />
              <Route path="/cleaner" element={<EmailCleaner />} />
            </Routes>
          </main>
        </div>
      </div>
    </BrowserRouter>
  )
}
