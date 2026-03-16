import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { Mail, Bot, Megaphone, FlaskConical, AlertTriangle, ArrowRight } from 'lucide-react'
import { mockEmails, mockAgents, mockSocialPosts, mockGoogleAdsSpend, mockResearchTasks } from '@/data/mock'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { cn } from '@/lib/utils'
import type { Email } from '@/types'
import { fetchEmails } from '@/lib/emailApi'

export function OverviewPage() {
  const [emails, setEmails] = useState<Email[]>(mockEmails)

  useEffect(() => {
    fetchEmails()
      .then(setEmails)
      .catch(() => setEmails(mockEmails))
  }, [])

  const unread = emails.filter((e) => !e.isRead)
  const pendingPosts = mockSocialPosts.filter((p) => p.status === 'draft' || p.status === 'scheduled')
  const ads = mockGoogleAdsSpend
  const adsPercent = (ads.monthlySpend / ads.monthlyBudget) * 100
  const recentResearch = mockResearchTasks.slice(0, 3)

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-xl font-semibold text-white">Good morning</h2>
        <p className="text-sm text-slate-400 mt-1">
          Here's your operational snapshot for RainSoft of the Wiregrass.
        </p>
      </div>

      {/* Ads Cap Banner */}
      {adsPercent >= 80 && (
        <div className={cn(
          'flex items-start gap-3 rounded-xl p-4 border',
          adsPercent >= 95
            ? 'bg-red-950/40 border-red-700'
            : 'bg-yellow-950/40 border-yellow-700'
        )}>
          <AlertTriangle className={cn('w-5 h-5 flex-shrink-0 mt-0.5', adsPercent >= 95 ? 'text-red-400' : 'text-yellow-400')} />
          <div>
            <p className={cn('text-sm font-semibold', adsPercent >= 95 ? 'text-red-300' : 'text-yellow-300')}>
              Google Ads — {adsPercent.toFixed(0)}% of $100/mo hard cap used
            </p>
            <p className="text-xs text-slate-400 mt-0.5">
              ${ads.monthlySpend.toFixed(2)} spent · ${(ads.monthlyBudget - ads.monthlySpend).toFixed(2)} remaining this month
            </p>
          </div>
          <Link to="/marketing" className="ml-auto text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1 flex-shrink-0">
            View <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      )}

      {/* Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
        {/* Unread Email */}
        <Card>
          <CardHeader>
            <CardTitle>
              <Mail className="w-4 h-4 text-blue-400" />
              Unread Emails
            </CardTitle>
            <Link to="/email" className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {unread.length === 0 ? (
              <p className="text-sm text-slate-500">All caught up!</p>
            ) : (
              unread.slice(0, 3).map((email) => (
                <div key={email.id} className="flex items-start gap-3 py-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-1.5 flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white truncate">{email.sender}</p>
                    <p className="text-xs text-slate-400 truncate">{email.subject}</p>
                  </div>
                  <span className="text-xs text-slate-500 whitespace-nowrap ml-auto">{email.time}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        {/* Agent Status */}
        <Card>
          <CardHeader>
            <CardTitle>
              <Bot className="w-4 h-4 text-blue-400" />
              Agent Status
            </CardTitle>
            <Link to="/agents" className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-2">
            {mockAgents.map((agent) => (
              <div key={agent.id} className="flex items-center gap-3">
                <span className="text-lg">{agent.emoji}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-white">{agent.name}</p>
                  <p className="text-xs text-slate-500 truncate">{agent.lastTask}</p>
                </div>
                <Badge variant={agent.status}>{agent.status}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Pending Posts */}
        <Card>
          <CardHeader>
            <CardTitle>
              <Megaphone className="w-4 h-4 text-blue-400" />
              Pending Posts
            </CardTitle>
            <Link to="/marketing" className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
              View all <ArrowRight className="w-3 h-3" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-3">
            {pendingPosts.slice(0, 3).map((post) => (
              <div key={post.id} className="flex items-start gap-3">
                <span className="text-sm mt-0.5">
                  {post.platform === 'Facebook' ? '📘' : post.platform === 'TikTok' ? '🎵' : '📸'}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-slate-300 truncate">{post.content}</p>
                  <p className="text-xs text-slate-500 mt-0.5">{post.scheduledTime}</p>
                </div>
                <Badge variant={post.status as 'draft' | 'scheduled'}>{post.status}</Badge>
              </div>
            ))}
          </CardContent>
        </Card>

        {/* Google Ads */}
        <Card>
          <CardHeader>
            <CardTitle>
              <div className="text-sm">G</div>
              Google Ads Spend
            </CardTitle>
            <Link to="/marketing" className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
              Manage <ArrowRight className="w-3 h-3" />
            </Link>
          </CardHeader>
          <CardContent className="space-y-4">
            <div>
              <div className="flex justify-between items-baseline mb-2">
                <span className="text-xs text-slate-400">Monthly (Hard Cap: $100)</span>
                <span className={cn(
                  'text-xl font-bold font-mono',
                  adsPercent >= 95 ? 'text-red-400' : adsPercent >= 80 ? 'text-yellow-400' : 'text-white'
                )}>
                  ${ads.monthlySpend.toFixed(2)}
                  <span className="text-sm text-slate-500 font-normal">/$100</span>
                </span>
              </div>
              <ProgressBar
                value={ads.monthlySpend}
                max={ads.monthlyBudget}
                showLabel
              />
            </div>
            <div className="grid grid-cols-3 gap-3 pt-1">
              {ads.campaigns.map((c) => (
                <div key={c.id} className="bg-slate-800/50 rounded-lg p-2.5 text-center">
                  <p className="text-xs text-slate-500 truncate">{c.name.split('–')[0].trim()}</p>
                  <p className="text-sm font-semibold font-mono text-slate-200 mt-1">${c.spend}</p>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Research */}
      <Card>
        <CardHeader>
          <CardTitle>
            <FlaskConical className="w-4 h-4 text-blue-400" />
            Recent Research
          </CardTitle>
          <Link to="/research" className="text-xs text-blue-400 hover:text-blue-300 flex items-center gap-1">
            View all <ArrowRight className="w-3 h-3" />
          </Link>
        </CardHeader>
        <CardContent className="space-y-3">
          {recentResearch.map((task) => (
            <div key={task.id} className="flex items-start gap-3">
              <div className="mt-0.5">
                <Badge variant={task.status as 'completed' | 'in-progress' | 'pending'}>{task.status}</Badge>
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-white">{task.topic}</p>
                <p className="text-xs text-slate-400 mt-0.5 line-clamp-1">{task.summary}</p>
              </div>
              <span className="text-xs text-slate-500 whitespace-nowrap ml-auto">{task.dateCompleted}</span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
