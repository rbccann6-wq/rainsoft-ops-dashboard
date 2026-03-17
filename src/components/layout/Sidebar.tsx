import { NavLink } from 'react-router-dom'
import { Mail, Bot, Megaphone, FlaskConical, LayoutDashboard, Target, Receipt, Trash2, DollarSign, CreditCard, Users } from 'lucide-react'
import { cn } from '@/lib/utils'

const navItems = [
  { to: '/', icon: LayoutDashboard, label: 'Overview' },
  { to: '/email', icon: Mail, label: 'Email' },
  { to: '/agents', icon: Bot, label: 'Agents' },
  { to: '/marketing', icon: Megaphone, label: 'Marketing' },
  { to: '/research', icon: FlaskConical, label: 'Research' },
  { to: '/leads', icon: Target, label: 'Leads' },
  { to: '/bills', icon: Receipt, label: 'Bills' },
  { to: '/cleaner', icon: Trash2, label: 'Cleaner' },
  { to: '/costs', icon: DollarSign, label: 'Costs' },
  { to: '/finance', icon: CreditCard, label: 'Finance Agent' },
  { to: '/all-leads', icon: Users, label: 'All Leads' },
]

export function Sidebar() {
  return (
    <nav className="w-14 lg:w-52 flex-shrink-0 border-r border-slate-800 bg-slate-950 flex flex-col py-4 gap-1">
      {navItems.map(({ to, icon: Icon, label }) => (
        <NavLink
          key={to}
          to={to}
          end={to === '/'}
          className={({ isActive }) =>
            cn(
              'flex items-center gap-3 px-3 py-2.5 mx-2 rounded-md text-sm transition-colors',
              isActive
                ? 'bg-blue-600/20 text-blue-300 border border-blue-700/50'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
            )
          }
        >
          <Icon className="w-4 h-4 flex-shrink-0" />
          <span className="hidden lg:inline truncate">{label}</span>
        </NavLink>
      ))}
    </nav>
  )
}
