import { useState } from 'react'
import { FlaskConical, Plus, ExternalLink, Tag } from 'lucide-react'
import { mockResearchTasks } from '@/data/mock'
import type { ResearchTask, ResearchStatus } from '@/types'
import { Card, CardContent } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Modal } from '@/components/ui/Modal'

export function ResearchFeed() {
  const [tasks, setTasks] = useState<ResearchTask[]>(mockResearchTasks)
  const [showNew, setShowNew] = useState(false)
  const [newTopic, setNewTopic] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)

  function createTask() {
    if (!newTopic.trim()) return
    const task: ResearchTask = {
      id: `r${Date.now()}`,
      topic: newTopic.trim(),
      summary: 'Task queued — Scout will begin research shortly.',
      dateCompleted: 'Queued',
      status: 'pending',
      sources: 0,
      tags: [],
    }
    setTasks((prev) => [task, ...prev])
    setNewTopic('')
    setShowNew(false)
  }

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <FlaskConical className="w-5 h-5 text-blue-400" />
          <h2 className="text-lg font-semibold text-white">Research Feed</h2>
          <Badge variant="default">{tasks.length} tasks</Badge>
        </div>
        <Button variant="primary" size="sm" onClick={() => setShowNew(true)}>
          <Plus className="w-3.5 h-3.5" />
          New Research Task
        </Button>
      </div>

      <div className="space-y-3">
        {tasks.map((task) => (
          <ResearchCard
            key={task.id}
            task={task}
            expanded={expanded === task.id}
            onToggle={() => setExpanded(expanded === task.id ? null : task.id)}
          />
        ))}
      </div>

      <Modal
        open={showNew}
        onClose={() => setShowNew(false)}
        title="New Research Task"
        size="sm"
      >
        <div className="p-5 space-y-4">
          <div className="space-y-1">
            <label className="text-xs text-slate-400">Research Topic</label>
            <input
              type="text"
              value={newTopic}
              onChange={(e) => setNewTopic(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && createTask()}
              placeholder="e.g. Alabama water quality regulations 2025"
              className="w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-blue-500"
              autoFocus
            />
          </div>
          <p className="text-xs text-slate-500">
            Scout will research this topic and deliver a summary with sources.
          </p>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              onClick={createTask}
              disabled={!newTopic.trim()}
            >
              Queue Task
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setShowNew(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

function ResearchCard({
  task,
  expanded,
  onToggle,
}: {
  task: ResearchTask
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <Card hoverable onClick={onToggle}>
      <CardContent className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-sm font-semibold text-white">{task.topic}</h3>
              <Badge variant={task.status as ResearchStatus}>{task.status}</Badge>
            </div>
            <p
              className={`text-sm text-slate-400 mt-1 leading-relaxed ${
                expanded ? '' : 'line-clamp-2'
              }`}
            >
              {task.summary}
            </p>
          </div>
        </div>

        {task.tags.length > 0 && (
          <div className="flex items-center gap-2 flex-wrap">
            <Tag className="w-3 h-3 text-slate-500" />
            {task.tags.map((tag) => (
              <span
                key={tag}
                className="px-2 py-0.5 rounded-full bg-slate-800 text-xs text-slate-400 border border-slate-700"
              >
                {tag}
              </span>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between text-xs text-slate-500">
          <div className="flex items-center gap-3">
            <span>{task.dateCompleted}</span>
            {task.sources > 0 && (
              <>
                <span>·</span>
                <span className="flex items-center gap-1">
                  <ExternalLink className="w-3 h-3" />
                  {task.sources} sources
                </span>
              </>
            )}
          </div>
          <span className="text-slate-600">{expanded ? 'collapse ↑' : 'expand ↓'}</span>
        </div>
      </CardContent>
    </Card>
  )
}
