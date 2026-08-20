'use client'

import Link from 'next/link'
import { useAuth } from '@/lib/hooks'
import TaskBoard from '@/components/TaskBoard'
import { AppNav } from '@/components/AppNav'

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
      <AppNav
        current="/tasks"
        userName={user.full_name}
        isAdmin={user.access_level === 'admin'}
        onSignOut={signOut}
      />

      <main className="max-w-3xl mx-auto px-4 py-8">
        <h1 className="text-lg font-bold text-deep-purple mb-1">Tasks</h1>
        <div className="w-14 h-[3px] bg-steel-blue rounded mb-2" />
        <p className="text-sm text-gray mb-6">
          Anything that comes up during the week. Assign it, give it a due date, and the owner gets a
          Slack DM they can close by replying &ldquo;done&rdquo;. Commitments from your 1-on-1s show
          up here too, and anything shared to your department appears so you can pick it up.
        </p>

        <TaskBoard
        userId={user.id}
        userName={user.full_name}
        department={user.department}
        accessLevel={user.access_level}
      />
      </main>
    </div>
  )
}
