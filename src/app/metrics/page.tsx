'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useAuth, useMetrics } from '@/lib/hooks'
import {
  statsFor, onTimeRate, assignmentFlow, closureChannels, windowStart,
  type PersonStats,
} from '@/lib/metrics'
import { COMPLETED_VIA_LABEL } from '@/lib/types'

const PERIODS = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
]

export default function MetricsPage() {
  const { user, loading: authLoading, signOut } = useAuth()
  const [days, setDays] = useState(30)
  const { people, tasks, events, loading, error, migrationNeeded, eventsAvailable } = useMetrics(user?.id)

  if (authLoading) {
    return <main className="max-w-3xl mx-auto px-4 py-8"><p className="text-sm text-gray">Loading...</p></main>
  }
  if (!user) {
    return (
      <main className="max-w-3xl mx-auto px-4 py-8">
        <p className="text-sm text-gray">You need to be signed in to see metrics.</p>
      </main>
    )
  }

  const since = windowStart(days)
  const nameFor = (id: string) => {
    const p = people.find(x => x.id === id)
    return p?.full_name || p?.email || 'Someone'
  }

  const stats = people
    .map(p => statsFor(p.id, tasks, events, { since }))
    .sort((a, b) => b.overdue - a.overdue || b.open - a.open)

  const flow = assignmentFlow(tasks)
  const channels = closureChannels(tasks)
  const openUndated = stats.reduce((n, s) => n + s.openUndated, 0)
  const aloneInScope = people.length <= 1

  return (
    <div className="min-h-screen">
      <header className="bg-deep-purple px-4 sm:px-6 py-3 flex items-center justify-between gap-x-3 gap-y-2 flex-wrap sticky top-0 z-50">
        <div className="flex items-center gap-3 sm:gap-4">
          <span className="text-white font-bold tracking-wider text-lg">DATAVATIONS</span>
          <nav className="flex items-center gap-3 text-sm">
            <Link href="/" className="text-white/60 hover:text-white transition">Agenda</Link>
            <Link href="/tasks" className="text-white/60 hover:text-white transition">Tasks</Link>
            <Link href="/team" className="text-white/60 hover:text-white transition">Team</Link>
            <span className="text-white font-semibold">Metrics</span>
          </nav>
        </div>
        <div className="flex items-center gap-3 sm:gap-4">
          <span className="text-steel-blue font-semibold text-sm hidden sm:inline">{user.full_name}</span>
          <button onClick={signOut} className="text-white/60 text-sm hover:text-white transition">
            Sign out
          </button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8">
        <h1 className="text-lg font-bold text-deep-purple mb-1">Accountability</h1>
        <div className="w-14 h-[3px] bg-steel-blue rounded mb-2" />
        <p className="text-sm text-gray mb-6">
          You, and everyone below you in the reporting line. Authority flows down, so a
          department head sees their reports&apos; reports without anything being granted twice.
        </p>

        {migrationNeeded && (
          <div className="bg-amber-light text-[#e67e22] text-sm p-3 rounded-lg mb-6">
            Run <span className="font-mono">supabase-metrics.sql</span> in the Supabase SQL editor.
            It adds <span className="font-mono">team_ids()</span>, which decides whose numbers you
            may see, so nothing can be shown until it exists.
          </div>
        )}
        {error && (
          <div className="bg-red-light text-coral-red text-sm p-3 rounded-lg mb-6">{error}</div>
        )}

        <div className="flex items-center gap-2 mb-6 flex-wrap">
          <span className="text-[11px] font-bold uppercase tracking-wide text-gray">Closed work over</span>
          {PERIODS.map(p => (
            <button
              key={p.days}
              onClick={() => setDays(p.days)}
              className={`px-3 py-1 rounded-full text-xs font-semibold transition ${
                days === p.days ? 'bg-deep-purple text-white' : 'border border-light-gray text-gray hover:border-steel-blue'
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>

        {loading ? (
          <p className="text-sm text-gray">Loading metrics...</p>
        ) : people.length === 0 ? (
          migrationNeeded ? null : <p className="text-sm text-gray">Nothing to show yet.</p>
        ) : (
          <div className="space-y-6">
            {aloneInScope && (
              <div className="bg-white border border-light-gray rounded-xl p-4 text-sm text-gray">
                Only your own numbers so far. Set someone&apos;s manager on the{' '}
                <Link href="/team" className="text-steel-blue underline">Team</Link> page and their
                work appears here.
              </div>
            )}

            {!eventsAvailable && (
              <div className="bg-amber-light text-[#e67e22] text-sm p-3 rounded-lg">
                Deadline changes aren&apos;t being recorded yet, so the on-time figures below
                can&apos;t tell a task delivered on time from one whose date was moved to stay
                ahead of it. <span className="font-mono">supabase-metrics.sql</span> adds that log.
              </div>
            )}

            {stats.map(s => <PersonCard key={s.personId} s={s} name={nameFor(s.personId)} days={days} eventsAvailable={eventsAvailable} />)}

            {openUndated > 0 && (
              <div className="bg-white border border-light-gray rounded-xl p-4">
                <p className="text-sm text-near-black">
                  <span className="font-bold">{openUndated}</span> open task
                  {openUndated === 1 ? '' : 's'} with no due date.
                </p>
                <p className="text-xs text-gray mt-1">
                  These can never be on time or late, so they sit outside every figure above.
                  Undated work is the easiest place for things to quietly stop moving.
                </p>
              </div>
            )}

            {flow.length > 0 && (
              <div className="bg-white border border-light-gray rounded-xl p-5">
                <h2 className="text-[11px] font-bold uppercase tracking-wide text-medium-purple mb-1">
                  Where work comes from
                </h2>
                <p className="text-xs text-gray mb-3">
                  Handovers only — work someone assigned to themselves isn&apos;t counted.
                </p>
                <div className="space-y-1">
                  {flow.map(e => (
                    <div key={`${e.creatorId}-${e.assigneeId}`} className="flex items-center gap-2 text-sm">
                      <span className="text-near-black">{nameFor(e.creatorId)}</span>
                      <span className="text-light-gray">→</span>
                      <span className="text-near-black">{nameFor(e.assigneeId)}</span>
                      <span className="text-gray text-xs ml-auto tabular-nums">{e.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {channels.length > 0 && (
              <div className="bg-white border border-light-gray rounded-xl p-5">
                <h2 className="text-[11px] font-bold uppercase tracking-wide text-medium-purple mb-1">
                  How work gets closed
                </h2>
                <p className="text-xs text-gray mb-3">
                  Whether the Slack and email routes are earning their keep.
                </p>
                <div className="space-y-1">
                  {channels.map(c => (
                    <div key={c.via} className="flex items-center gap-2 text-sm">
                      <span className="text-near-black">
                        {c.via === 'unrecorded' ? 'Closed before this was tracked' : COMPLETED_VIA_LABEL[c.via] || c.via}
                      </span>
                      <span className="text-gray text-xs ml-auto tabular-nums">{c.count}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  )
}

/** One person's numbers. Cards rather than a table so nothing scrolls sideways on a phone. */
function PersonCard({ s, name, days, eventsAvailable }: {
  s: PersonStats
  name: string
  days: number
  eventsAvailable: boolean
}) {
  const rate = onTimeRate(s)
  const judged = s.onTime + s.late

  return (
    <div className={`bg-white rounded-xl p-5 border ${s.overdue > 0 ? 'border-coral-red' : 'border-light-gray'}`}>
      <div className="flex items-baseline justify-between gap-2 flex-wrap mb-3">
        <h2 className="font-bold text-deep-purple">{name}</h2>
        {rate === null ? (
          <span className="text-xs text-gray" title="Too few finished tasks with a due date to be meaningful">
            On time: not enough data
          </span>
        ) : (
          <span className={`text-sm font-bold ${rate >= 80 ? 'text-green' : rate >= 50 ? 'text-[#e67e22]' : 'text-coral-red'}`}>
            {rate}% on time
            <span className="text-gray font-normal text-xs"> of {judged}</span>
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <Stat label="Open" value={s.open} />
        <Stat label="Overdue" value={s.overdue} tone={s.overdue > 0 ? 'bad' : undefined} />
        <Stat
          label="Oldest open"
          value={s.oldestOpenDays === null ? '—' : `${s.oldestOpenDays}d`}
          tone={s.oldestOpenDays !== null && s.oldestOpenDays > 30 ? 'bad' : undefined}
        />
        <Stat label={`Closed / ${days}d`} value={s.closed} />
      </div>

      <p className="text-xs text-gray mt-3">
        {s.onTime} on time · {s.late} late · {s.undated} closed with no date
        {s.assignedOut > 0 && <> · {s.assignedOut} assigned to others</>}
        {eventsAvailable && s.deadlinesMoved > 0 && (
          <span className="text-[#e67e22]"> · {s.deadlinesMoved} deadline{s.deadlinesMoved === 1 ? '' : 's'} moved</span>
        )}
      </p>
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: number | string; tone?: 'bad' }) {
  return (
    <div>
      <div className={`text-xl font-bold tabular-nums ${tone === 'bad' ? 'text-coral-red' : 'text-near-black'}`}>
        {value}
      </div>
      <div className="text-[11px] font-bold uppercase tracking-wide text-gray">{label}</div>
    </div>
  )
}
