'use client'

import Link from 'next/link'
import { useAuth } from '@/lib/hooks'
import TaskBoard from '@/components/TaskBoard'

/**
 * The day-to-day task page.
 *
 * Separate from the meeting agenda on purpose: work that comes up mid-week has
 * nothing to do with any particular 1-on-1, and burying it inside one means
 * having to remember which meeting it came from to find it again.
 */
export default function TasksPage() {
  const { user, loading, signOut } = useAuth()

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray">Loading tasks...</div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <p className="text-gray mb-3">You need to be signed in to see your tasks.</p>
          <Link href="/" className="text-steel-blue font-semibold hover:underline">
            Go to sign in
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen">
      <header className="bg-deep-purple px-6 py-4 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-4">
          <span className="text-white font-bold tracking-wider text-lg">DATAVATIONS</span>
          <nav className="flex items-center gap-3 text-sm">
            <Link href="/" className="text-white/60 hover:text-white transition">Agenda</Link>
            <span className="text-white font-semibold">Tasks</span>
            <Link href="/team" className="text-white/60 hover:text-white transition">Team</Link>
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-steel-blue font-semibold text-sm">{user.full_name}</span>
          <button onClick={signOut} className="text-white/60 text-sm hover:text-white transition">
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8">
        <h1 className="text-lg font-bold text-deep-purple mb-1">Tasks</h1>
        <div className="w-14 h-[3px] bg-steel-blue rounded mb-2" />
        <p className="text-sm text-gray mb-6">
          Anything that comes up during the week. Assign it, give it a due date, and the owner gets a
          Slack DM they can close by replying &ldquo;done&rdquo;. Commitments from your 1-on-1s show
          up here too, and anything shared to your department appears so you can pick it up.
        </p>

        <TaskBoard userId={user.id} userName={user.full_name} department={user.department} />
      </main>
    </div>
  )
}
