'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useAuth, useMetrics } from '@/lib/hooks'
import {
  statsFor, onTimeRate, assignmentFlow, closureChannels, addDays,
  previousRange, rangeLength, type PersonStats,
} from '@/lib/metrics'
import { todayISO } from '@/lib/tracker'
import { quarterOf, quarterRange } from '@/lib/quarters'
import { COMPLETED_VIA_LABEL } from '@/lib/types'
import { AppNav } from '@/components/AppNav'

/**
 * N days ending today, counting today.
 *
 * Inclusive on both ends so the label matches the window: today-7 through today is
 * eight days, and a button reading "7 days" over a card reading "Closed / 8d" is
 * the kind of small lie that makes people stop trusting the rest.
 */
function lastNDays(n: number, today: string) {
  return { from: addDays(today, -(n - 1)), to: today }
}

/** Shortcuts that fill the dates in. The dates remain the source of truth. */
const PRESETS = [
  { label: '7 days', range: (today: string) => lastNDays(7, today) },
  { label: '30 days', range: (today: string) => lastNDays(30, today) },
  { label: '90 days', range: (today: string) => lastNDays(90, today) },
  {
    label: 'This quarter',
    range: (today: string) => {
      const { start, end } = quarterRange(quarterOf(today))
      // Not past today: a quarter that has not finished should not be compared
      // against a full one, and counting to its end would read as a shortfall.
      return { from: start, to: end < today ? end : today }
    },
  },
]

function humanDate(iso: string): string {
  if (!iso) return ''
  const [y, m, d] = iso.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

export default function MetricsPage() {
  const { user, loading: authLoading, signOut } = useAuth()
  const today = todayISO()
  // Thirty days by default, but the dates are what count — presets only fill them in.
  const [from, setFrom] = useState(() => lastNDays(30, todayISO()).from)
  const [to, setTo] = useState(() => todayISO())
  const [comparing, setComparing] = useState(false)
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

  const nameFor = (id: string) => {
    const p = people.find(x => x.id === id)
    return p?.full_name || p?.email || 'Someone'
  }

  const backwards = Boolean(from && to && from > to)
  const previous = comparing && !backwards ? previousRange(from, to) : null
  const spanDays = backwards ? 0 : rangeLength(from, to)

  const stats = backwards
    ? []
    : people
        .map(p => statsFor(p.id, tasks, events, { since: from, until: to }))
        .sort((a, b) => b.overdue - a.overdue || b.open - a.open)

  const priorStats = previous
    ? new Map(people.map(p => [p.id, statsFor(p.id, tasks, events, { since: previous.from, until: previous.to })]))
    : null

  const flow = assignmentFlow(tasks)
  const channels = closureChannels(tasks)
  const openUndated = stats.reduce((n, s) => n + s.openUndated, 0)
  const aloneInScope = people.length <= 1

  return (
    <div className="min-h-screen">
      <AppNav
        current="/metrics"
        userName={user.full_name}
        isAdmin={user.access_level === 'admin'}
        onSignOut={signOut}
      />

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

        <div className="bg-white border border-light-gray rounded-xl p-4 mb-6">
          <div className="flex items-end gap-3 flex-wrap">
            <div>
              <label htmlFor="metrics-from" className="text-[11px] font-bold uppercase tracking-wide text-gray block mb-1">
                From
              </label>
              <input
                id="metrics-from"
                type="date"
                value={from}
                max={to || undefined}
                onChange={e => setFrom(e.target.value)}
                className="border border-light-gray rounded-lg px-3 py-2 text-sm focus:border-steel-blue focus:outline-none"
              />
            </div>
            <div>
              <label htmlFor="metrics-to" className="text-[11px] font-bold uppercase tracking-wide text-gray block mb-1">
                To
              </label>
              <input
                id="metrics-to"
                type="date"
                value={to}
                min={from || undefined}
                onChange={e => setTo(e.target.value)}
                className="border border-light-gray rounded-lg px-3 py-2 text-sm focus:border-steel-blue focus:outline-none"
              />
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {PRESETS.map(p => {
                const r = p.range(today)
                const active = r.from === from && r.to === to
                return (
                  <button
                    key={p.label}
                    onClick={() => { setFrom(r.from); setTo(r.to) }}
                    className={`px-3 py-1 rounded-full text-xs font-semibold transition ${
                      active ? 'bg-deep-purple text-white' : 'border border-light-gray text-gray hover:border-steel-blue'
                    }`}
                  >
                    {p.label}
                  </button>
                )
              })}
            </div>
          </div>

          <label className="flex items-start gap-2 mt-3 text-xs text-gray cursor-pointer">
            <input
              type="checkbox"
              checked={comparing}
              onChange={e => setComparing(e.target.checked)}
              className="mt-0.5"
            />
            <span>
              Compare with the previous {spanDays} day{spanDays === 1 ? '' : 's'}
              {previous && (
                <span className="text-near-black font-semibold"> · {humanDate(previous.from)} – {humanDate(previous.to)}</span>
              )}
            </span>
          </label>

          {backwards && (
            <p className="text-xs text-coral-red mt-2">
              The From date is after the To date, so there is no period to measure.
            </p>
          )}
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

            {comparing && (
              <p className="text-xs text-gray">
                Only closed work is compared. Open, overdue and oldest-open describe today, not a
                period, so a change between two windows would mean nothing.
              </p>
            )}

            {stats.map(s => (
              <PersonCard
                key={s.personId}
                s={s}
                prior={priorStats?.get(s.personId) ?? null}
                name={nameFor(s.personId)}
                spanDays={spanDays}
                eventsAvailable={eventsAvailable}
              />
            ))}

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
function PersonCard({ s, prior, name, spanDays, eventsAvailable }: {
  s: PersonStats
  /** The same person over the preceding window, when comparing. */
  prior: PersonStats | null
  name: string
  spanDays: number
  eventsAvailable: boolean
}) {
  const rate = onTimeRate(s)
  const judged = s.onTime + s.late
  const priorRate = prior ? onTimeRate(prior) : null

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
            {/* Only when both windows have enough to publish a rate; comparing a
                number against "not enough data" would invent a trend. */}
            {priorRate !== null && <Delta value={rate - priorRate} suffix="pt" />}
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
        <Stat
          label={`Closed / ${spanDays}d`}
          value={s.closed}
          delta={prior ? s.closed - prior.closed : undefined}
        />
      </div>

      <p className="text-xs text-gray mt-3">
        {s.onTime} on time
        {prior && <Delta value={s.onTime - prior.onTime} />}
        {' · '}{s.late} late
        {prior && <Delta value={s.late - prior.late} goodWhen="down" />}
        {' · '}{s.undated} closed with no date
        {s.assignedOut > 0 && <> · {s.assignedOut} assigned to others</>}
        {eventsAvailable && s.deadlinesMoved > 0 && (
          <span className="text-[#e67e22]"> · {s.deadlinesMoved} deadline{s.deadlinesMoved === 1 ? '' : 's'} moved</span>
        )}
      </p>
    </div>
  )
}

/**
 * Change against the comparison window.
 *
 * Direction is not always improvement, so each caller says which way is good:
 * closing more is progress, being late more often is not.
 */
function Delta({ value, goodWhen = 'up', suffix = '' }: {
  value: number
  goodWhen?: 'up' | 'down'
  suffix?: string
}) {
  if (value === 0) return <span className="text-light-gray text-xs font-normal"> ±0</span>
  const good = goodWhen === 'up' ? value > 0 : value < 0
  return (
    <span className={`text-xs font-semibold ${good ? 'text-green' : 'text-coral-red'}`}>
      {' '}{value > 0 ? '+' : '\u2212'}{Math.abs(value)}{suffix}
    </span>
  )
}

function Stat({ label, value, tone, delta }: {
  label: string
  value: number | string
  tone?: 'bad'
  delta?: number
}) {
  return (
    <div>
      <div className={`text-xl font-bold tabular-nums ${tone === 'bad' ? 'text-coral-red' : 'text-near-black'}`}>
        {value}
        {delta !== undefined && <Delta value={delta} />}
      </div>
      <div className="text-[11px] font-bold uppercase tracking-wide text-gray">{label}</div>
    </div>
  )
}
