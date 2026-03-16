import { useState } from 'react'
import { Megaphone, Plus, TrendingUp, AlertTriangle } from 'lucide-react'
import { mockSocialPosts, mockGoogleAdsSpend } from '@/data/mock'
import type { SocialPost, SocialPlatform, PostStatus } from '@/types'
import { Card, CardContent } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { cn } from '@/lib/utils'

const platformIcon: Record<SocialPlatform, string> = {
  Facebook: '📘',
  TikTok: '🎵',
  Instagram: '📸',
}

const platformColor: Record<SocialPlatform, string> = {
  Facebook: 'text-blue-400',
  TikTok: 'text-pink-400',
  Instagram: 'text-purple-400',
}

export function MarketingHub() {
  const [posts, setPosts] = useState<SocialPost[]>(mockSocialPosts)
  const [showCreatePost, setShowCreatePost] = useState(false)
  const [newPost, setNewPost] = useState<Partial<SocialPost>>({
    platform: 'Facebook',
    content: '',
    status: 'draft',
  })
  const ads = mockGoogleAdsSpend

  const adsPercent = (ads.monthlySpend / ads.monthlyBudget) * 100
  const adsNearCap = adsPercent >= 80
  const adsCritical = adsPercent >= 95

  function createPost() {
    if (!newPost.content) return
    const post: SocialPost = {
      id: `p${Date.now()}`,
      platform: newPost.platform as SocialPlatform,
      content: newPost.content!,
      scheduledTime: newPost.scheduledTime || 'Not scheduled',
      status: 'draft',
    }
    setPosts((prev) => [post, ...prev])
    setShowCreatePost(false)
    setNewPost({ platform: 'Facebook', content: '', status: 'draft' })
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Megaphone className="w-5 h-5 text-blue-400" />
        <h2 className="text-lg font-semibold text-white">Marketing Hub</h2>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-5">
        {/* Social Queue */}
        <div className="xl:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium text-slate-300">Social Post Queue</h3>
            <Button variant="primary" size="sm" onClick={() => setShowCreatePost(true)}>
              <Plus className="w-3.5 h-3.5" />
              Create Post
            </Button>
          </div>
          <Card>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800">
                    <th className="text-left px-5 py-3 text-xs text-slate-500 font-medium">Platform</th>
                    <th className="text-left px-3 py-3 text-xs text-slate-500 font-medium">Content</th>
                    <th className="text-left px-3 py-3 text-xs text-slate-500 font-medium hidden sm:table-cell">Scheduled</th>
                    <th className="text-left px-3 py-3 text-xs text-slate-500 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {posts.map((post) => (
                    <PostRow key={post.id} post={post} />
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>

        {/* Ads Spend */}
        <div className="space-y-4">
          <h3 className="text-sm font-medium text-slate-300">Google Ads Spend</h3>
          <Card>
            <CardContent className="space-y-5">
              {/* Monthly Cap Warning */}
              {adsCritical && (
                <div className="flex items-start gap-2 bg-red-950/50 border border-red-700 rounded-lg p-3">
                  <AlertTriangle className="w-4 h-4 text-red-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-red-300">NEAR HARD CAP</p>
                    <p className="text-xs text-red-400 mt-0.5">
                      Monthly spend approaching $100 limit. Consider pausing campaigns.
                    </p>
                  </div>
                </div>
              )}
              {adsNearCap && !adsCritical && (
                <div className="flex items-start gap-2 bg-yellow-950/50 border border-yellow-700 rounded-lg p-3">
                  <AlertTriangle className="w-4 h-4 text-yellow-400 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-xs font-semibold text-yellow-300">APPROACHING CAP</p>
                    <p className="text-xs text-yellow-400 mt-0.5">
                      {(ads.monthlyBudget - ads.monthlySpend).toFixed(2)} remaining this month.
                    </p>
                  </div>
                </div>
              )}

              {/* Monthly */}
              <div>
                <div className="flex justify-between items-baseline mb-2">
                  <span className="text-xs text-slate-400">Monthly Spend</span>
                  <span className={cn('text-lg font-bold font-mono', adsCritical ? 'text-red-400' : adsNearCap ? 'text-yellow-400' : 'text-white')}>
                    ${ads.monthlySpend.toFixed(2)}
                  </span>
                </div>
                <ProgressBar
                  value={ads.monthlySpend}
                  max={ads.monthlyBudget}
                  showLabel
                  label={`Hard Cap: $${ads.monthlyBudget}/mo`}
                />
              </div>

              {/* Daily */}
              <div>
                <div className="flex justify-between items-baseline mb-2">
                  <span className="text-xs text-slate-400">Today's Spend</span>
                  <span className="text-sm font-semibold font-mono text-slate-200">
                    ${ads.dailySpend.toFixed(2)}
                  </span>
                </div>
                <ProgressBar
                  value={ads.dailySpend}
                  max={ads.dailyBudget}
                  showLabel
                  label={`Daily Budget: $${ads.dailyBudget.toFixed(2)}`}
                  colorThresholds={{ warning: 60, critical: 85 }}
                />
              </div>

              <div className="text-xs text-slate-500 flex items-center gap-1">
                <TrendingUp className="w-3 h-3" />
                Updated {ads.lastUpdated}
              </div>

              {/* Campaigns */}
              <div className="border-t border-slate-800 pt-4 space-y-3">
                <p className="text-xs font-medium text-slate-400">Campaigns</p>
                {ads.campaigns.map((c) => (
                  <div key={c.id} className="space-y-1">
                    <div className="flex justify-between items-center">
                      <p className="text-xs text-slate-300 truncate max-w-[160px]">{c.name}</p>
                      <span className="text-xs font-mono text-slate-400">${c.spend.toFixed(2)}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span>{c.clicks} clicks</span>
                      <span>·</span>
                      <span>{c.impressions.toLocaleString()} impr.</span>
                      <span>·</span>
                      <Badge variant={c.status === 'active' ? 'active' : 'idle'} className="text-xs">
                        {c.status}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Create Post Modal */}
      <Modal
        open={showCreatePost}
        onClose={() => setShowCreatePost(false)}
        title="Create Post"
        size="md"
      >
        <div className="p-5 space-y-4">
          <div className="space-y-1">
            <label className="text-xs text-slate-400">Platform</label>
            <select
              value={newPost.platform}
              onChange={(e) => setNewPost((p) => ({ ...p, platform: e.target.value as SocialPlatform }))}
              className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
            >
              <option value="Facebook">📘 Facebook</option>
              <option value="TikTok">🎵 TikTok</option>
              <option value="Instagram">📸 Instagram</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-slate-400">Content</label>
            <textarea
              value={newPost.content || ''}
              onChange={(e) => setNewPost((p) => ({ ...p, content: e.target.value }))}
              placeholder="Write your post content..."
              rows={6}
              className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 resize-none"
            />
            <p className="text-xs text-slate-500 text-right">
              {(newPost.content || '').length} chars
            </p>
          </div>
          <div className="space-y-1">
            <label className="text-xs text-slate-400">Schedule (optional)</label>
            <input
              type="text"
              value={newPost.scheduledTime || ''}
              onChange={(e) => setNewPost((p) => ({ ...p, scheduledTime: e.target.value }))}
              placeholder="e.g. Tomorrow, 9:00 AM"
              className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
            />
          </div>
          <div className="flex gap-2 pt-1">
            <Button
              variant="primary"
              size="sm"
              onClick={createPost}
              disabled={!newPost.content}
            >
              Save as Draft
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowCreatePost(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

function PostRow({ post }: { post: SocialPost }) {
  return (
    <tr className="border-b border-slate-800/50 hover:bg-slate-800/30 transition-colors">
      <td className="px-5 py-3">
        <div className="flex items-center gap-1.5">
          <span>{platformIcon[post.platform]}</span>
          <span className={cn('text-xs font-medium', platformColor[post.platform])}>
            {post.platform}
          </span>
        </div>
      </td>
      <td className="px-3 py-3 max-w-0">
        <p className="text-sm text-slate-300 truncate">{post.content}</p>
        {post.engagementHint && (
          <p className="text-xs text-slate-500">{post.engagementHint}</p>
        )}
      </td>
      <td className="px-3 py-3 text-xs text-slate-400 whitespace-nowrap hidden sm:table-cell">
        {post.scheduledTime}
      </td>
      <td className="px-3 py-3">
        <Badge variant={post.status as PostStatus}>{post.status}</Badge>
      </td>
    </tr>
  )
}
