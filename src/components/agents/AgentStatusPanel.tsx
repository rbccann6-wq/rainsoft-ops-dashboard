import { Bot, Activity, Clock } from 'lucide-react'
import { mockAgents } from '@/data/mock'
import type { Agent, AgentStatus } from '@/types'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { cn } from '@/lib/utils'

const statusDot: Record<AgentStatus, string> = {
  active: 'bg-emerald-400',
  working: 'bg-blue-400 animate-pulse',
  idle: 'bg-slate-500',
}

export function AgentStatusPanel() {
  const activeCount = mockAgents.filter(
    (a) => a.status === 'active' || a.status === 'working'
  ).length

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3">
        <Bot className="w-5 h-5 text-blue-400" />
        <h2 className="text-lg font-semibold text-white">Agent Status</h2>
        <Badge variant="active">{activeCount} active</Badge>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {mockAgents.map((agent) => (
          <AgentCard key={agent.id} agent={agent} />
        ))}
      </div>
    </div>
  )
}

function AgentCard({ agent }: { agent: Agent }) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-center gap-3">
          <div className="text-2xl">{agent.emoji}</div>
          <div>
            <p className="text-sm font-semibold text-white">{agent.name}</p>
            <p className="text-xs text-slate-400">{agent.role}</p>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <div className={cn('w-2 h-2 rounded-full', statusDot[agent.status])} />
          <Badge variant={agent.status}>{agent.status}</Badge>
        </div>
      </div>

      <div className="space-y-2 border-t border-slate-800 pt-3">
        <div className="flex items-start gap-2">
          <Activity className="w-3.5 h-3.5 text-slate-500 mt-0.5 flex-shrink-0" />
          <p className="text-xs text-slate-300 leading-relaxed line-clamp-2">
            {agent.lastTask}
          </p>
        </div>
        <div className="flex items-center gap-2 justify-between">
          <div className="flex items-center gap-1.5">
            <Clock className="w-3 h-3 text-slate-500" />
            <span className="text-xs text-slate-500">{agent.lastTaskTime}</span>
          </div>
          <span className="text-xs text-slate-500">
            {agent.tasksToday} tasks today
          </span>
        </div>
      </div>
    </Card>
  )
}
