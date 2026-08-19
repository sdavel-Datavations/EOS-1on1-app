'use client'

import { useAuth, useMeetings, createMeeting, deleteMeeting, describeMeetingError, useSchedules } from '@/lib/hooks'
import { todayISO } from '@/lib/tracker'
import { addDays } from '@/lib/metrics'
import {
  nextOccurrence, adherence, describeMissed, describeDate, CADENCE_LABEL, WEEKDAYS,
  type ScheduledMeeting,
} from '@/lib/schedule'
import TaskSummary from '@/components/TaskSummary'
import { getResolvedSupabaseUrl } from '@/lib/supabase'
import { useState } from 'react'
import Link from 'next/link'
import type { Meeting } from '@/lib/types'

/**
 * Signup is gated on an invitation by a trigger on auth.users, but GoTrue
 * replaces a trigger's message with a generic "Database error creating new
 * user" — so the real reason never reaches the browser. Rather than show that,
 * name the only thing that trigger rejects.
 */
function describeSignUpError(message: string): string {
  if (/database error|unexpected_failure/i.test(message)) {
    return 'Could not create that account. Signup is invite-only — ask an admin to invite your email address, then try again.'
  }
  return message
}

export default function Home() {
  const { user, loading: authLoading, signIn, signUp, signOut } = useAuth()
  const { meetings, loading: meetingsLoading, refetch } = useMeetings(user?.id)
  const [showAuth, setShowAuth] = useState<'login' | 'signup'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [fullName, setFullName] = useState('')
  const [error, setError] = useState('')
  const [reportEmail, setReportEmail] = useState('')
  const [creating, setCreating] = useState(false)
  const [confirmingId, setConfirmingId] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState('')

  const remove = async (meetingId: string) => {
    setDeletingId(meetingId)
    setDeleteError('')
    const { error } = await deleteMeeting(meetingId)
    if (error) setDeleteError(error)
    setConfirmingId(null)
    setDeletingId(null)
    await refetch()
  }

  if (authLoading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray">Loading...</div>
      </div>
    )
  }

  // ── Auth Screen ──
  if (!user) {
    const supabaseInfo = getResolvedSupabaseUrl()
    return (
      <div className="flex items-center justify-center min-h-screen bg-bg">
        <div className="bg-white rounded-xl shadow-lg p-8 w-full max-w-md">
          {supabaseInfo.original && (
            <div className={`text-xs p-2 mb-4 rounded ${supabaseInfo.autoCorrected ? 'bg-amber-50 text-amber-800' : 'bg-yellow-50 text-yellow-800'}`}>
              Supabase URL (runtime): {supabaseInfo.original}
              {supabaseInfo.autoCorrected && <span> — auto-resolved to {supabaseInfo.resolved}</span>}
            </div>
          )}
          <div className="text-center mb-6">
            <h1 className="text-2xl font-bold text-deep-purple tracking-wide">DATAVATIONS</h1>
            <p className="text-gray text-sm mt-1">Weekly 1-on-1 Agenda</p>
            <div className="w-16 h-[3px] bg-steel-blue rounded mx-auto mt-3" />
          </div>

          {error && <div className="bg-red-light text-coral-red text-sm p-3 rounded-lg mb-4">{error}</div>}

          <div className="space-y-4">
            {showAuth === 'signup' && (
              <input
                type="text"
                placeholder="Full name"
                value={fullName}
                onChange={e => setFullName(e.target.value)}
                className="w-full border border-light-gray rounded-lg px-4 py-2.5 text-sm focus:border-steel-blue focus:outline-none"
              />
            )}
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={e => setEmail(e.target.value)}
              className="w-full border border-light-gray rounded-lg px-4 py-2.5 text-sm focus:border-steel-blue focus:outline-none"
            />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              className="w-full border border-light-gray rounded-lg px-4 py-2.5 text-sm focus:border-steel-blue focus:outline-none"
            />
            <button
              onClick={async () => {
                setError('')
                try {
                  if (showAuth === 'login') {
                    const res = await signIn(email, password)
                    // safe logging for debugging (no secrets)
                    // eslint-disable-next-line no-console
                    console.log('signIn response', { status: res?.error ? 'error' : 'ok', error: res?.error?.message })
                    if (res?.error) setError(res.error.message)
                  } else {
                    const res = await signUp(email, password, fullName)
                    // eslint-disable-next-line no-console
                    console.log('signUp response', { status: res?.error ? 'error' : 'ok', error: res?.error?.message })
                    if (res?.error) setError(describeSignUpError(res.error.message))
                  }
                } catch (err) {
                  // eslint-disable-next-line no-console
                  console.error('Auth action failed', err)
                  setError('Authentication failed — check console for details')
                }
              }}
              className="w-full bg-steel-blue text-white font-semibold py-2.5 rounded-lg hover:bg-[#25698f] transition"
            >
              {showAuth === 'login' ? 'Sign In' : 'Create Account'}
            </button>
          </div>

          <p className="text-center text-sm text-gray mt-4">
            {showAuth === 'login' ? (
              <>No account? <button onClick={() => setShowAuth('signup')} className="text-steel-blue font-semibold">Sign up</button></>
            ) : (
              <>Have an account? <button onClick={() => setShowAuth('login')} className="text-steel-blue font-semibold">Sign in</button></>
            )}
          </p>
        </div>
      </div>
    )
  }

  // ── Main Dashboard ──
  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="bg-deep-purple px-4 sm:px-6 py-3 flex items-center justify-between gap-x-3 gap-y-2 flex-wrap sticky top-0 z-50">
        <div className="flex items-center gap-3 sm:gap-4">
          <span className="text-white font-bold tracking-wider text-lg">DATAVATIONS</span>
          <nav className="flex items-center gap-3 text-sm">
            <span className="text-white font-semibold">Agenda</span>
            <Link href="/tasks" className="text-white/60 hover:text-white transition">Tasks</Link>
            <Link href="/team" className="text-white/60 hover:text-white transition">Team</Link>
            <Link href="/metrics" className="text-white/60 hover:text-white transition">Metrics</Link>
          </nav>
        </div>
        <div className="flex items-center gap-3 sm:gap-4">
          <span className="text-steel-blue font-semibold text-sm hidden sm:inline">{user.full_name}</span>
          <button onClick={signOut} className="text-white/60 text-sm hover:text-white transition">Sign out</button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8">
        {/* The board itself lives at /tasks; this is just the way in. */}
        <TaskSummary userId={user.id} />

        {/* When the next 1-on-1 is due, and which weeks got skipped */}
        <CadencePanel userId={user.id} meetings={meetings} />

        {/* New Meeting */}
        <div className="bg-white rounded-xl border border-light-gray p-6 mb-8">
          <h2 className="text-lg font-bold text-deep-purple mb-1">New Meeting</h2>
          <div className="w-14 h-[3px] bg-steel-blue rounded mb-4" />
          {error && <div className="bg-red-light text-coral-red text-sm p-3 rounded-lg mb-4">{error}</div>}
          <div className="flex gap-3 items-end flex-wrap">
            <div>
              <label className="text-[11px] font-bold uppercase tracking-wide text-gray block mb-1">Direct Report Email</label>
              <input
                type="email"
                placeholder="ashley@datavations.com"
                value={reportEmail}
                onChange={e => { setReportEmail(e.target.value); setError('') }}
                className="border border-light-gray rounded-lg px-3 py-2 text-sm w-64 focus:border-steel-blue focus:outline-none"
              />
            </div>
            <button
              disabled={creating}
              onClick={async () => {
                setCreating(true)
                setError('')
                // Look up report by email
                let reportId = null
                if (reportEmail.trim()) {
                  const { createClient } = await import('@/lib/supabase')
                  const supabase = createClient()
                  const { data } = await supabase.from('profiles').select('id').eq('email', reportEmail.trim().toLowerCase()).maybeSingle()
                  if (!data) {
                    // Don't silently create a meeting with an empty report seat
                    setError(`No account for ${reportEmail.trim()} — they need to sign up first, or leave the field blank.`)
                    setCreating(false)
                    return
                  }
                  reportId = data.id
                }
                // todayISO is local. toISOString() is UTC, so a meeting started
                // in the evening in the Americas was being dated tomorrow — which
                // also broke carry-forward, since that keys off meeting_date.
                const today = todayISO()
                const { data, error: createError } = await createMeeting(user.id, reportId, today)
                // Never fail silently here: the button just flipping back to
                // "Start 1-on-1" is indistinguishable from a dead click.
                if (createError || !data) {
                  setError(createError ? describeMeetingError(createError) : 'Could not create the meeting.')
                  setCreating(false)
                  return
                }
                await refetch()
                window.location.href = `/meeting/${data.id}`
              }}
              className="bg-steel-blue text-white font-semibold px-5 py-2 rounded-lg hover:bg-[#25698f] transition text-sm"
            >
              {creating ? 'Creating...' : 'Start 1-on-1'}
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="mb-6">
          <SearchBar />
        </div>

        {/* Past Meetings */}
        <h2 className="text-lg font-bold text-deep-purple mb-1">Meeting History</h2>
        <div className="w-14 h-[3px] bg-steel-blue rounded mb-4" />

        {deleteError && (
          <div className="bg-red-light text-coral-red text-sm p-3 rounded-lg mb-4">{deleteError}</div>
        )}

        {meetingsLoading ? (
          <p className="text-gray text-sm">Loading meetings...</p>
        ) : meetings.length === 0 ? (
          <div className="bg-white rounded-xl border border-light-gray p-8 text-center">
            <p className="text-gray">No meetings yet. Start your first 1-on-1 above.</p>
          </div>
        ) : (
          <div className="space-y-3">
            {meetings.map(m => {
              const mt = m as Meeting & { manager?: { full_name: string }; report?: { full_name: string } }
              return (
                <Link href={`/meeting/${m.id}`} key={m.id}>
                  <div className="bg-white rounded-xl border border-light-gray p-4 hover:border-steel-blue transition cursor-pointer flex items-center justify-between group mb-3">
                    <div>
                      <div className="flex items-center gap-3">
                        <span className="font-semibold text-deep-purple">
                          {new Date(m.meeting_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
                        </span>
                        <span className={`text-xs font-bold px-2 py-0.5 rounded-full ${
                          m.status === 'completed' ? 'bg-green-light text-green' :
                          m.status === 'active' ? 'bg-[#e8f0fe] text-steel-blue' :
                          'bg-amber-light text-[#e67e22]'
                        }`}>
                          {m.status.toUpperCase()}
                        </span>
                      </div>
                      <p className="text-sm text-gray mt-1">
                        {mt.manager?.full_name} + {mt.report?.full_name || 'TBD'}
                      </p>
                    </div>
                    <div className="flex items-center gap-3">
                      {m.rating && (
                        <span className="text-steel-blue font-bold text-lg">{m.rating}/10</span>
                      )}
                      {confirmingId === m.id ? (
                        <div
                          className="flex items-center gap-2"
                          onClick={e => { e.preventDefault(); e.stopPropagation() }}
                        >
                          <span className="text-xs text-gray">Delete this meeting and its agenda?</span>
                          <button
                            onClick={() => remove(m.id)}
                            disabled={deletingId === m.id}
                            className="bg-coral-red text-white text-xs font-semibold px-2 py-1 rounded disabled:opacity-50"
                          >
                            {deletingId === m.id ? 'Deleting...' : 'Delete'}
                          </button>
                          <button
                            onClick={() => setConfirmingId(null)}
                            className="border border-light-gray text-gray text-xs font-semibold px-2 py-1 rounded"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={e => {
                            e.preventDefault()
                            e.stopPropagation()
                            setDeleteError('')
                            setConfirmingId(m.id)
                          }}
                          title="Delete meeting"
                          aria-label="Delete meeting"
                          className="text-light-gray hover:text-coral-red transition text-lg px-1 opacity-0 group-hover:opacity-100 focus:opacity-100"
                        >
                          &times;
                        </button>
                      )}
                      <span className="text-light-gray group-hover:text-steel-blue transition text-xl">&rarr;</span>
                    </div>
                  </div>
                </Link>
              )
            })}
          </div>
        )}
      </main>
    </div>
  )
}

// ── Search Component ──
function SearchBar() {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<{ issues: any[]; todos: any[] } | null>(null)
  const [searching, setSearching] = useState(false)

  const search = async () => {
    if (!query.trim()) return
    setSearching(true)
    const { searchPastMeetings } = await import('@/lib/hooks')
    const r = await searchPastMeetings(query)
    setResults(r)
    setSearching(false)
  }

  return (
    <div>
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="Search past issues, to-dos, discussions..."
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && search()}
          className="flex-1 border border-light-gray rounded-lg px-4 py-2.5 text-sm focus:border-steel-blue focus:outline-none"
        />
        <button
          onClick={search}
          disabled={searching}
          className="bg-medium-purple text-white font-semibold px-4 py-2 rounded-lg hover:bg-deep-purple transition text-sm"
        >
          {searching ? '...' : 'Search'}
        </button>
      </div>
      {results && (
        <div className="mt-3 bg-white rounded-xl border border-light-gray p-4 space-y-3">
          {results.issues.length === 0 && results.todos.length === 0 ? (
            <p className="text-gray text-sm">No results found.</p>
          ) : (
            <>
              {results.issues.map((issue: any) => (
                <Link href={`/meeting/${issue.meeting?.id}`} key={issue.id}>
                  <div className="flex items-start gap-2 p-2 rounded-lg hover:bg-bg transition cursor-pointer">
                    <span className="text-xs font-bold px-1.5 py-0.5 rounded bg-red-light text-coral-red">ISSUE</span>
                    <div>
                      <p className="text-sm font-medium text-near-black">{issue.description}</p>
                      <p className="text-xs text-gray">{issue.meeting?.meeting_date} — {issue.resolution || 'No resolution yet'}</p>
                    </div>
                  </div>
                </Link>
              ))}
              {results.todos.map((todo: any) => (
                <Link href={`/meeting/${todo.meeting?.id}`} key={todo.id}>
                  <div className="flex items-start gap-2 p-2 rounded-lg hover:bg-bg transition cursor-pointer">
                    <span className="text-xs font-bold px-1.5 py-0.5 rounded bg-green-light text-green">TODO</span>
                    <div>
                      <p className="text-sm font-medium text-near-black">{todo.text}</p>
                      <p className="text-xs text-gray">{todo.meeting?.meeting_date} — {todo.done ? 'Done' : 'Open'}</p>
                    </div>
                  </div>
                </Link>
              ))}
            </>
          )}
          <button onClick={() => setResults(null)} className="text-xs text-gray hover:text-near-black">Clear results</button>
        </div>
      )}
    </div>
  )
}

/**
 * The cadence: when each 1-on-1 is next due, and which weeks were skipped.
 *
 * Skipped weeks were previously invisible. A meeting only existed if somebody
 * created one, so a week nobody held left no trace — the single most useful thing
 * a weekly tool could tell you, and the one thing it could not.
 *
 * Nothing here creates a meeting. A row written by a scheduler would be
 * indistinguishable from one that happened, which would erase the gaps.
 */
function CadencePanel({ userId, meetings }: { userId: string; meetings: Meeting[] }) {
  const { schedules, people, loading, migrationNeeded } = useSchedules(userId)
  const today = todayISO()

  if (loading || migrationNeeded || schedules.length === 0) return null

  const scheduled: ScheduledMeeting[] = meetings.map(m => ({
    meeting_date: m.meeting_date,
    manager_id: m.manager_id,
    report_id: m.report_id,
  }))
  // Eight weeks back: long enough to show a pattern, short enough that a gap from
  // months ago is not still being reported as news.
  const from = addDays(today, -56)

  const rows = schedules
    .filter(s => s.active)
    .map(s => {
      const other = s.manager_id === userId ? s.report_id : s.manager_id
      const person = people.find(p => p.id === other)
      return {
        schedule: s,
        name: person?.full_name || person?.email || 'your 1-on-1',
        next: nextOccurrence(s, today),
        record: adherence(s, scheduled, from, today, today),
      }
    })

  if (rows.length === 0) return null

  return (
    <div className="bg-white rounded-xl border border-light-gray p-6 mb-8">
      <h2 className="text-lg font-bold text-deep-purple mb-1">Cadence</h2>
      <div className="w-14 h-[3px] bg-steel-blue rounded mb-4" />
      <div className="space-y-3">
        {rows.map(({ schedule, name, next, record }) => {
          const missedNote = describeMissed(record.missed)
          const dueToday = next === today
          return (
            <div key={schedule.id} className={`p-3 rounded-lg border ${
              record.missed.length > 1 ? 'border-coral-red bg-red-light' : 'border-light-gray'
            }`}>
              <div className="flex items-baseline justify-between gap-2 flex-wrap">
                <span className="font-semibold text-sm text-near-black">{name}</span>
                <span className={`text-xs ${dueToday ? 'text-steel-blue font-bold' : 'text-gray'}`}>
                  {next ? (dueToday ? 'Due today' : `Next ${describeDate(next)}`) : 'Paused'}
                </span>
              </div>
              <div className="text-xs text-gray mt-1">
                {CADENCE_LABEL[schedule.cadence]} on {WEEKDAYS[schedule.weekday]} ·{' '}
                held {record.held.length} of {record.held.length + record.missed.length} in the last 8 weeks
              </div>
              {missedNote && (
                <div className={`text-xs mt-1 font-semibold ${record.missed.length > 1 ? 'text-coral-red' : 'text-[#e67e22]'}`}>
                  {missedNote}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
