import { useState, useEffect, useCallback } from 'react'
import { Mail, Paperclip, RefreshCw, Loader2, WifiOff } from 'lucide-react'
import { mockEmails } from '@/data/mock'
import type { Email, EmailDraft } from '@/types'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'
import { cn } from '@/lib/utils'
import { fetchEmails, createDraftReply, sendReply } from '@/lib/emailApi'

export function EmailDashboard() {
  const [emails, setEmails] = useState<Email[]>([])
  const [loading, setLoading] = useState(true)
  const [usingMock, setUsingMock] = useState(false)
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null)
  const [composeDraft, setComposeDraft] = useState<Partial<EmailDraft> | null>(null)
  const [drafts, setDrafts] = useState<EmailDraft[]>([])
  const [showDrafts, setShowDrafts] = useState(false)
  const [savingDraft, setSavingDraft] = useState(false)
  const [sendingId, setSendingId] = useState<string | null>(null)

  const loadEmails = useCallback(async () => {
    setLoading(true)
    try {
      const data = await fetchEmails()
      setEmails(data)
      setUsingMock(false)
    } catch (err) {
      console.warn('Email API unavailable, falling back to mock data:', err)
      setEmails(mockEmails)
      setUsingMock(true)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadEmails()
  }, [loadEmails])

  const unreadCount = emails.filter((e) => !e.isRead).length

  function openEmail(email: Email) {
    setEmails((prev) =>
      prev.map((e) => (e.id === email.id ? { ...e, isRead: true } : e))
    )
    setSelectedEmail({ ...email, isRead: true })
  }

  function openCompose(email?: Email) {
    setComposeDraft({
      to: email ? email.senderEmail : '',
      subject: email ? `Re: ${email.subject}` : '',
      body: email
        ? `\n\n---\nOn ${email.time}, ${email.sender} wrote:\n${email.body
            .split('\n')
            .map((l) => `> ${l}`)
            .join('\n')}`
        : '',
      inReplyTo: email?.id,
    })
  }

  async function saveDraft() {
    if (!composeDraft?.to || !composeDraft?.subject) return

    setSavingDraft(true)
    let graphDraftId: string | undefined

    if (composeDraft.inReplyTo && !usingMock) {
      try {
        const result = await createDraftReply(
          composeDraft.inReplyTo,
          composeDraft.body || '',
        )
        graphDraftId = result.draftId
      } catch (err) {
        console.warn('Could not save draft via API, keeping local only:', err)
      }
    }

    const draft: EmailDraft = {
      id: `d${Date.now()}`,
      to: composeDraft.to!,
      subject: composeDraft.subject!,
      body: composeDraft.body || '',
      inReplyTo: composeDraft.inReplyTo,
      graphDraftId,
      status: 'draft',
      createdAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    }
    setDrafts((prev) => [...prev, draft])
    setComposeDraft(null)
    setSavingDraft(false)
  }

  function approveDraft(id: string) {
    setDrafts((prev) =>
      prev.map((d) => (d.id === id ? { ...d, status: 'approved' } : d))
    )
  }

  async function sendApproved(id: string) {
    const draft = drafts.find((d) => d.id === id)
    if (!draft) return

    setSendingId(id)
    if (draft.graphDraftId) {
      try {
        await sendReply(draft.graphDraftId)
      } catch (err) {
        console.error('Failed to send reply via API:', err)
        setSendingId(null)
        return
      }
    }
    setDrafts((prev) =>
      prev.map((d) => (d.id === id ? { ...d, status: 'sent' } : d))
    )
    setSendingId(null)
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Mail className="w-5 h-5 text-blue-400" />
          <h2 className="text-lg font-semibold text-white">Email Inbox</h2>
          {unreadCount > 0 && (
            <Badge variant="unread">{unreadCount} unread</Badge>
          )}
          {usingMock && (
            <span className="flex items-center gap-1 text-xs text-amber-400/80">
              <WifiOff className="w-3 h-3" /> offline — mock data
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {drafts.length > 0 && (
            <Button variant="ghost" size="sm" onClick={() => setShowDrafts(true)}>
              Drafts ({drafts.length})
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={loadEmails}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <RefreshCw className="w-3.5 h-3.5" />
            )}
            <span className="hidden sm:inline">Refresh</span>
          </Button>
          <Button variant="primary" size="sm" onClick={() => openCompose()}>
            Compose
          </Button>
        </div>
      </div>

      {/* Table */}
      <Card>
        {loading && emails.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-16 text-slate-500">
            <Loader2 className="w-4 h-4 animate-spin" />
            <span className="text-sm">Loading inbox…</span>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800">
                  <th className="text-left px-5 py-3 text-xs text-slate-500 font-medium w-8"></th>
                  <th className="text-left px-3 py-3 text-xs text-slate-500 font-medium">Sender</th>
                  <th className="text-left px-3 py-3 text-xs text-slate-500 font-medium">Subject & Preview</th>
                  <th className="text-left px-3 py-3 text-xs text-slate-500 font-medium hidden md:table-cell">Time</th>
                  <th className="text-left px-3 py-3 text-xs text-slate-500 font-medium w-20">Status</th>
                </tr>
              </thead>
              <tbody>
                {emails.map((email) => (
                  <EmailRow
                    key={email.id}
                    email={email}
                    onClick={() => openEmail(email)}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {/* Email Detail Modal */}
      <Modal
        open={!!selectedEmail}
        onClose={() => setSelectedEmail(null)}
        title={selectedEmail?.subject || ''}
        size="lg"
      >
        {selectedEmail && (
          <div className="p-5 space-y-4">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-white">{selectedEmail.sender}</p>
                <p className="text-xs text-slate-400">{selectedEmail.senderEmail}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-slate-400">{selectedEmail.time}</p>
                {selectedEmail.hasAttachment && (
                  <span className="text-xs text-slate-500 flex items-center gap-1 justify-end mt-1">
                    <Paperclip className="w-3 h-3" /> Attachment
                  </span>
                )}
              </div>
            </div>
            <div className="border-t border-slate-800 pt-4">
              <pre className="text-sm text-slate-300 whitespace-pre-wrap font-sans leading-relaxed">
                {selectedEmail.body}
              </pre>
            </div>
            <div className="border-t border-slate-800 pt-4 flex gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  openCompose(selectedEmail)
                  setSelectedEmail(null)
                }}
              >
                Draft Reply
              </Button>
              <Button variant="ghost" size="sm">
                Forward
              </Button>
              <Button variant="ghost" size="sm">
                Archive
              </Button>
            </div>
          </div>
        )}
      </Modal>

      {/* Compose Modal */}
      <Modal
        open={!!composeDraft}
        onClose={() => setComposeDraft(null)}
        title="Draft Reply"
        size="lg"
      >
        {composeDraft !== null && (
          <div className="p-5 space-y-4">
            <div className="space-y-1">
              <label className="text-xs text-slate-400">To</label>
              <input
                type="email"
                value={composeDraft.to || ''}
                onChange={(e) => setComposeDraft((d) => ({ ...d, to: e.target.value }))}
                className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-slate-400">Subject</label>
              <input
                type="text"
                value={composeDraft.subject || ''}
                onChange={(e) => setComposeDraft((d) => ({ ...d, subject: e.target.value }))}
                className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-slate-400">Body</label>
              <textarea
                value={composeDraft.body || ''}
                onChange={(e) => setComposeDraft((d) => ({ ...d, body: e.target.value }))}
                rows={10}
                className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500 resize-none font-mono"
              />
            </div>
            <div className="flex items-center gap-2 pt-1">
              <Button
                variant="primary"
                size="sm"
                onClick={saveDraft}
                disabled={savingDraft}
              >
                {savingDraft ? (
                  <>
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Saving…
                  </>
                ) : (
                  'Save Draft'
                )}
              </Button>
              <p className="text-xs text-slate-500">
                Drafts require approval before sending
              </p>
            </div>
          </div>
        )}
      </Modal>

      {/* Drafts Modal */}
      <Modal
        open={showDrafts}
        onClose={() => setShowDrafts(false)}
        title={`Drafts (${drafts.length})`}
        size="lg"
      >
        <div className="p-5 space-y-3">
          {drafts.length === 0 ? (
            <p className="text-sm text-slate-500">No drafts saved.</p>
          ) : (
            drafts.map((draft) => (
              <div
                key={draft.id}
                className="bg-slate-800 rounded-lg p-4 space-y-2 border border-slate-700"
              >
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-white">{draft.subject}</p>
                  <Badge
                    variant={
                      draft.status === 'sent'
                        ? 'posted'
                        : draft.status === 'approved'
                        ? 'active'
                        : 'draft'
                    }
                  >
                    {draft.status}
                  </Badge>
                </div>
                <p className="text-xs text-slate-400">To: {draft.to}</p>
                <pre className="text-xs text-slate-300 whitespace-pre-wrap font-sans line-clamp-3">
                  {draft.body}
                </pre>
                {draft.graphDraftId && (
                  <p className="text-xs text-slate-600">Saved to M365 Drafts</p>
                )}
                <div className="flex gap-2 pt-1">
                  {draft.status === 'draft' && (
                    <Button
                      variant="success"
                      size="sm"
                      onClick={() => approveDraft(draft.id)}
                    >
                      Approve
                    </Button>
                  )}
                  {draft.status === 'approved' && (
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={sendingId === draft.id}
                      onClick={() => sendApproved(draft.id)}
                    >
                      {sendingId === draft.id ? (
                        <>
                          <Loader2 className="w-3 h-3 animate-spin" />
                          Sending…
                        </>
                      ) : (
                        'Approve & Send'
                      )}
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
      </Modal>
    </div>
  )
}

function EmailRow({ email, onClick }: { email: Email; onClick: () => void }) {
  return (
    <tr
      onClick={onClick}
      className={cn(
        'border-b border-slate-800/50 cursor-pointer transition-colors',
        email.isRead
          ? 'hover:bg-slate-800/50'
          : 'bg-blue-950/10 hover:bg-blue-950/20'
      )}
    >
      <td className="px-5 py-3">
        {!email.isRead && (
          <div className="w-2 h-2 rounded-full bg-blue-400" />
        )}
      </td>
      <td className="px-3 py-3">
        <div className="flex items-center gap-2">
          <div
            className={cn(
              'text-sm',
              email.isRead ? 'text-slate-400' : 'text-white font-medium'
            )}
          >
            {email.sender}
          </div>
          {email.hasAttachment && (
            <Paperclip className="w-3 h-3 text-slate-500 flex-shrink-0" />
          )}
        </div>
        <div className="text-xs text-slate-500 hidden sm:block truncate max-w-[120px]">
          {email.senderEmail}
        </div>
      </td>
      <td className="px-3 py-3 max-w-0">
        <div
          className={cn(
            'text-sm truncate',
            email.isRead ? 'text-slate-300' : 'text-white font-medium'
          )}
        >
          {email.subject}
        </div>
        <div className="text-xs text-slate-500 truncate">{email.preview}</div>
      </td>
      <td className="px-3 py-3 text-xs text-slate-500 whitespace-nowrap hidden md:table-cell">
        {email.time}
      </td>
      <td className="px-3 py-3">
        <Badge variant={email.isRead ? 'read' : 'unread'}>
          {email.isRead ? 'Read' : 'New'}
        </Badge>
      </td>
    </tr>
  )
}
