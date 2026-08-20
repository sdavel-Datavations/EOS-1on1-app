'use client'

import { useEffect, useState } from 'react'
import { useAuth } from '@/lib/hooks'
import { AppNav } from '@/components/AppNav'
import {
  partitionProblems, channelSummary, channelVerdict, type DeliveryRow,
} from '@/lib/delivery'

/**
 * Whether the notification system is actually running.
 *
 * Two questions nothing else answers: has the scheduled pass happened, and is
 * anything failing to reach someone. Both used to need a hand-written query, which
 * means in practice nobody would, and a DM that silently failed to a colleague
 * would never be noticed.
 *
 * It lived on /metrics because that was the only admin-gated page — never because
 * it belonged there. Nothing here is a measure of anybody's work.
 */

const when = (iso: string) => new Date(iso).toLocaleString('en-GB', {
  day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
})

const VERDICT_TONE: Record<string, string> = {
  healthy: 'text-green',
  failing: 'text-coral-red',
  'never used': 'text-gray',
}

export default function DeliveryPage() {
  const { user, loading: authLoading, signOut } = useAuth()
  const [failures, setFailures] = useState<DeliveryRow[]>([])
  const [rows, setRows] = useState<DeliveryRow[]>([])
  const [lastSent, setLastSent] = useState<Record<string, string | null>>({})
  const [lastFailed, setLastFailed] = useState<Record<string, string | null>>({})
  const [lastRun, setLastRun] = useState<DeliveryRow | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [showResolved, setShowResolved] = useState(false)

  useEffect(() => {
    if (!user) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/notifications/recent')
        const json = await res.json()
        if (cancelled) return
        if (!res.ok) setError(json.error || 'Could not read the delivery log.')
        else {
          setRows(json.rows || [])
          setFailures(json.failures || [])
          setLastSent(json.lastSent || {})
          setLastFailed(json.lastFailed || {})
          setLastRun(json.lastRun || null)
        }
      } catch {
        if (!cancelled) setError('Could not reach the delivery log.')
      }
      if (!cancelled) setLoaded(true)
    })()
    return () => { cancelled = true }
  }, [user])

  if (authLoading) {
    return <main className="max-w-3xl mx-auto px-4 py-8"><p className="text-sm text-gray">Loading...</p></main>
  }
  if (!user) {
    return (
      <main className="max-w-3xl mx-auto px-4 py-8">
        <p className="text-sm text-gray">You need to be signed in to see delivery.</p>
      </main>
    )
  }

  const { live, resolved } = partitionProblems(failures, lastSent)
  const summary = channelSummary(lastSent, lastFailed)

  return (
    <div className="min-h-screen">
      <AppNav
        current="/delivery"
        userName={user.full_name}
        isAdmin={user.access_level === 'admin'}
        onSignOut={signOut}
      />

      <main className="max-w-3xl mx-auto px-4 py-8">
        <h1 className="text-lg font-bold text-deep-purple mb-1">Delivery</h1>
        <p className="text-sm text-gray mb-5">
          Whether notifications are reaching people. Admins only.
        </p>

        {user.access_level !== 'admin' ? (
          <p className="text-sm text-gray">
            This page is for admins. The log carries rows about people outside any one
            reporting line, so there is no version of it scoped to a manager.
          </p>
        ) : error ? (
          <p className="text-sm text-coral-red">{error}</p>
        ) : !loaded ? (
          <p className="text-sm text-gray">Reading the log...</p>
        ) : (
          <div className="space-y-4">
            {/* Channels first: this is the "is it working right now" answer. */}
            <div className="bg-white border border-light-gray rounded-xl p-5">
              <h2 className="text-[11px] font-bold uppercase tracking-wide text-medium-purple mb-3">
                Right now
              </h2>
              <div className="space-y-2">
                {summary.map(c => {
                  const verdict = channelVerdict(c)
                  return (
                    <div key={c.channel} className="flex items-baseline gap-2 text-sm flex-wrap">
                      <span className="text-near-black font-semibold capitalize w-14">{c.channel}</span>
                      <span className={`font-semibold ${VERDICT_TONE[verdict]}`}>{verdict}</span>
                      <span className="text-xs text-gray ml-auto tabular-nums">
                        {c.lastSent ? `last sent ${when(c.lastSent)}` : 'nothing sent yet'}
                      </span>
                    </div>
                  )
                })}
                <div className="flex items-baseline gap-2 text-sm flex-wrap pt-2 border-t border-light-gray">
                  <span className="text-near-black font-semibold w-14">Cron</span>
                  {lastRun ? (
                    <>
                      <span className="text-green font-semibold">seen</span>
                      <span className="text-xs text-gray ml-auto tabular-nums">
                        {when(lastRun.created_at)} — {lastRun.detail}
                      </span>
                    </>
                  ) : (
                    <span className="text-[#e67e22] text-xs">
                      not seen yet. It writes a line here every time it fires, including when
                      there is nothing due — so once one appears, the cron is confirmed working.
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Only failures a later send has not answered. */}
            {live.length === 0 ? (
              <p className="text-sm text-green">Nothing is failing.</p>
            ) : (
              <div className="bg-white border border-coral-red rounded-xl p-5">
                <p className="text-sm text-coral-red font-semibold mb-2">
                  {live.length} unanswered failure{live.length === 1 ? '' : 's'}
                </p>
                <div className="space-y-1">
                  {live.slice(0, 10).map((r, i) => (
                    <div key={`${r.created_at}-${i}`} className="text-xs text-gray">
                      <span className="tabular-nums">{when(r.created_at)}</span>{' '}
                      <span className="font-semibold text-near-black">{r.channel}</span>{' '}
                      {r.detail || 'no detail recorded'}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/*
              Kept, but out of the way. A failure that a later send answered is history,
              and history reported as news is how a panel earns being ignored.
            */}
            {resolved.length > 0 && (
              <div className="bg-white border border-light-gray rounded-xl p-5">
                <button
                  onClick={() => setShowResolved(v => !v)}
                  className="text-sm font-semibold text-deep-purple"
                >
                  Earlier problems · {resolved.length} · answered by a later send
                  <span className="text-gray font-normal"> {showResolved ? '▾' : '▸'}</span>
                </button>
                {showResolved && (
                  <div className="space-y-1 mt-3">
                    {resolved.map((r, i) => (
                      <div key={`${r.created_at}-${i}`} className="text-xs text-gray">
                        <span className="tabular-nums">{when(r.created_at)}</span>{' '}
                        <span className="font-semibold text-near-black">{r.channel}</span>{' '}
                        {r.detail || 'no detail recorded'}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            <p className="text-[11px] text-light-gray">{rows.length} recent events in the log</p>
          </div>
        )}
      </main>
    </div>
  )
}
