'use client'


import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { useAuth, useSchedules, upsertSchedule, deleteSchedule, describeScheduleError } from '@/lib/hooks'
import { WEEKDAYS, CADENCE_LABEL, type Schedule, type Cadence } from '@/lib/schedule'
import { createClient } from '@/lib/supabase'

type Person = {
  id: string
  full_name: string | null
  email: string | null
  access_level: 'member' | 'manager' | 'admin' | null
  manager_id: string | null
  department: string | null
}

type Invite = {
  id: string
  email: string
  access_level: string
  manager_id: string | null
  department: string | null
  accepted_at: string | null
}

const LEVELS = ['member', 'manager', 'admin'] as const

export default function TeamPage() {
  const { user, loading: authLoading, signOut } = useAuth()
  // Above the `if (!user) return` below: a hook after an early return is called
  // conditionally, which takes the whole page down with a rules-of-hooks error.
  const {
    schedules, migrationNeeded: schedulesMissing, refetch: refetchSchedules,
  } = useSchedules(user?.id)

  const [people, setPeople] = useState<Person[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [loading, setLoading] = useState(true)
  const [notReady, setNotReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const [email, setEmail] = useState('')
  const [managerId, setManagerId] = useState('')
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('member')
  const [dept, setDept] = useState('')

  const isAdmin = user?.access_level === 'admin'

  const load = useCallback(async () => {
    if (!user) return
    const sb = createClient()

    const { data: profiles, error: profileError } = await sb
      .from('profiles')
      .select('id, full_name, email, access_level, manager_id, department')
      .order('full_name')

    if (profileError && /access_level|does not exist|could not find/i.test(profileError.message)) {
      setNotReady(true)
      setLoading(false)
      return
    }
    setPeople((profiles as Person[]) || [])

    // No insert policy on invitations, so this read is the only client access.
    const { data: pending } = await sb
      .from('invitations')
      .select('id, email, access_level, manager_id, department, accepted_at')
      .is('accepted_at', null)
      .order('created_at', { ascending: false })
    setInvites((pending as Invite[]) || [])

    setLoading(false)
  }, [user])

  useEffect(() => { load() }, [load])

  const post = async (path: string, body: unknown) => {
    setBusy(true)
    setError(null)
    setNotice(null)
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const json = await res.json()
    setBusy(false)
    if (!res.ok) {
      setError(json.error || 'That did not work')
      return null
    }
    await load()
    return json
  }

  const invite = async () => {
    if (!email.trim()) return
    const result = await post('/api/team/invite', {
      email: email.trim(),
      manager_id: managerId || null,
      role: level,
      department: dept.trim() || null,
    })
    if (result) {
      setNotice(`${email.trim()} can now sign up. They'll land under the manager you picked.`)
      setEmail('')
    }
  }

  const setManager = async (userId: string, newManagerId: string) => {
    const result = await post('/api/team/manager', { user_id: userId, manager_id: newManagerId || null })
    if (result) setNotice('Reporting line updated.')
  }

  const setDepartment = async (userId: string, newDept: string) => {
    const person = people.find(p => p.id === userId)
    const result = await post('/api/team/manager', {
      user_id: userId,
      manager_id: person?.manager_id ?? null,
      department: newDept,
    })
    if (result) setNotice(newDept ? `Department set to ${newDept}.` : 'Department cleared.')
  }

  const setLevelFor = async (userId: string, newLevel: string) => {
    const person = people.find(p => p.id === userId)
    const result = await post('/api/team/manager', {
      user_id: userId,
      manager_id: person?.manager_id ?? null,
      role: newLevel,
    })
    if (result) setNotice('Access level updated.')
  }

  if (authLoading) {
    return <div className="flex items-center justify-center min-h-screen"><div className="text-gray">Loading...</div></div>
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center">
          <p className="text-gray mb-3">You need to be signed in.</p>
          <Link href="/" className="text-steel-blue font-semibold hover:underline">Go to sign in</Link>
        </div>
      </div>
    )
  }

  const nameFor = (id: string | null) => {
    if (!id) return '—'
    const p = people.find(x => x.id === id)
    return p?.full_name || p?.email || 'Unknown'
  }

  // Only people who can actually hold reports, to keep the picker usable.
  const possibleManagers = people.filter(p => p.access_level === 'manager' || p.access_level === 'admin')
  // Free text with suggestions, so a new department needs no migration.
  const departments = [...new Set(people.map(p => p.department).filter(Boolean) as string[])].sort()

  return (
    <div className="min-h-screen">
      <header className="bg-deep-purple px-4 sm:px-6 py-3 flex items-center justify-between gap-x-3 gap-y-2 flex-wrap sticky top-0 z-50">
        <div className="flex items-center gap-3 sm:gap-4">
          <span className="text-white font-bold tracking-wider text-lg">DATAVATIONS</span>
          <nav className="flex items-center gap-3 text-sm">
            <Link href="/" className="text-white/60 hover:text-white transition">Agenda</Link>
            <Link href="/tasks" className="text-white/60 hover:text-white transition">Tasks</Link>
            <Link href="/metrics" className="text-white/60 hover:text-white transition">Metrics</Link>
            <span className="text-white font-semibold">Team</span>
          </nav>
        </div>
        <div className="flex items-center gap-3 sm:gap-4">
          <span className="text-steel-blue font-semibold text-sm hidden sm:inline">{user.full_name}</span>
          <button onClick={signOut} className="text-white/60 text-sm hover:text-white transition">Sign out</button>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-4 py-8">
        <h1 className="text-lg font-bold text-deep-purple mb-1">Team</h1>
        <div className="w-14 h-[3px] bg-steel-blue rounded mb-2" />
        <p className="text-sm text-gray mb-6">
          Signup is invite-only. Inviting someone under a manager is what lets that manager see
          their 1-on-1s and tasks &mdash; read-only, so oversight never means editing an agenda.
          A department lets everyone in it see each other&apos;s shared tasks, so work can be picked
          up without being handed over. Commitments raised inside a 1-on-1 stay private by default.
        </p>

        {notReady && (
          <div className="bg-amber-light text-[#e67e22] text-sm p-3 rounded-lg mb-4">
            Access control isn&apos;t set up yet &mdash; run <strong>supabase-access-control.sql</strong> in
            the Supabase SQL editor.
          </div>
        )}
        {error && <div className="bg-red-light text-coral-red text-sm p-3 rounded-lg mb-4">{error}</div>}
        {notice && <div className="bg-[#e8f0fe] text-steel-blue text-sm p-3 rounded-lg mb-4">{notice}</div>}

        {!notReady && (
          <>
            <div className="bg-white rounded-xl border border-light-gray p-5 mb-8">
              <h2 className="text-sm font-bold text-deep-purple mb-3">Invite someone</h2>
              <div className="flex gap-2 items-end flex-wrap">
                <div className="flex-1 min-w-[200px]">
                  <label className="text-[11px] font-bold uppercase tracking-wide text-gray block mb-1">Email</label>
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="name@datavations.com"
                    className="border border-light-gray rounded-lg px-3 py-2 text-sm w-full focus:border-steel-blue focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-wide text-gray block mb-1">Manager</label>
                  <select
                    value={managerId}
                    onChange={e => setManagerId(e.target.value)}
                    className="border border-light-gray rounded-lg px-3 py-2 text-sm focus:border-steel-blue focus:outline-none"
                  >
                    <option value="">No manager</option>
                    {possibleManagers.map(p => (
                      <option key={p.id} value={p.id}>{p.full_name || p.email}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[11px] font-bold uppercase tracking-wide text-gray block mb-1">Department</label>
                  <input
                    list="departments"
                    value={dept}
                    onChange={e => setDept(e.target.value)}
                    placeholder="Marketing"
                    className="border border-light-gray rounded-lg px-3 py-2 text-sm w-36 focus:border-steel-blue focus:outline-none"
                  />
                  <datalist id="departments">
                    {departments.map(d => <option key={d} value={d} />)}
                  </datalist>
                </div>
                {isAdmin && (
                  <div>
                    <label className="text-[11px] font-bold uppercase tracking-wide text-gray block mb-1">Access</label>
                    <select
                      value={level}
                      onChange={e => setLevel(e.target.value as (typeof LEVELS)[number])}
                      className="border border-light-gray rounded-lg px-3 py-2 text-sm focus:border-steel-blue focus:outline-none"
                    >
                      {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
                    </select>
                  </div>
                )}
                <button
                  onClick={invite}
                  disabled={busy || !email.trim()}
                  className="bg-steel-blue text-white font-semibold px-4 py-2 rounded-lg text-sm hover:bg-[#25698f] transition disabled:opacity-50"
                >
                  {busy ? 'Inviting...' : 'Invite'}
                </button>
              </div>
              {!isAdmin && (
                <p className="text-xs text-gray mt-3">
                  You can invite people reporting to you. Only an admin can grant manager or admin access.
                </p>
              )}
            </div>

            {invites.length > 0 && (
              <>
                <h2 className="text-sm font-bold text-deep-purple mb-2">
                  Invited, not signed up yet &middot; {invites.length}
                </h2>
                <div className="space-y-2 mb-8">
                  {invites.map(i => (
                    <div key={i.id} className="flex items-center justify-between bg-white border border-light-gray rounded-lg p-3">
                      <span className="text-sm text-near-black">{i.email}</span>
                      <span className="text-xs text-gray">
                        {i.access_level}
                        {i.department ? ` · ${i.department}` : ''} &middot; reports to {nameFor(i.manager_id)}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <h2 className="text-sm font-bold text-deep-purple mb-2">
              People {loading ? '' : `· ${people.length}`}
            </h2>
            {loading ? (
              <p className="text-sm text-gray">Loading...</p>
            ) : (
              <div className="space-y-2">
                {people.map(p => (
                  <div key={p.id} className="flex items-center gap-3 bg-white border border-light-gray rounded-lg p-3 flex-wrap">
                    <div className="flex-1 min-w-[160px]">
                      <div className="font-semibold text-sm text-near-black">
                        {p.full_name || '(no name)'}
                        {p.id === user.id && <span className="text-xs text-gray font-normal"> &middot; you</span>}
                      </div>
                      <div className="text-xs text-gray">{p.email}</div>
                    </div>
                    {p.id !== user.id && (
                      <ScheduleControl
                        managerId={user.id}
                        reportId={p.id}
                        name={p.full_name || p.email || 'them'}
                        schedules={schedules}
                        migrationNeeded={schedulesMissing}
                        onSaved={refetchSchedules}
                      />
                    )}
                    {isAdmin ? (
                      <>
                        <select
                          value={p.manager_id || ''}
                          onChange={e => setManager(p.id, e.target.value)}
                          disabled={busy}
                          className="border border-light-gray rounded px-2 py-1 text-xs focus:border-steel-blue focus:outline-none disabled:opacity-50"
                        >
                          <option value="">No manager</option>
                          {possibleManagers.filter(m => m.id !== p.id).map(m => (
                            <option key={m.id} value={m.id}>{m.full_name || m.email}</option>
                          ))}
                        </select>
                        <input
                          list="departments"
                          defaultValue={p.department || ''}
                          onBlur={e => {
                            if ((e.target.value || '') !== (p.department || '')) setDepartment(p.id, e.target.value)
                          }}
                          placeholder="Department"
                          disabled={busy}
                          className="border border-light-gray rounded px-2 py-1 text-xs w-28 focus:border-steel-blue focus:outline-none disabled:opacity-50"
                        />
                        <select
                          value={p.access_level || 'member'}
                          onChange={e => setLevelFor(p.id, e.target.value)}
                          disabled={busy}
                          className="border border-light-gray rounded px-2 py-1 text-xs focus:border-steel-blue focus:outline-none disabled:opacity-50"
                        >
                          {LEVELS.map(l => <option key={l} value={l}>{l}</option>)}
                        </select>
                      </>
                    ) : (
                      <span className="text-xs text-gray">
                        {p.access_level || 'member'}
                        {p.department ? ` · ${p.department}` : ''} &middot; reports to {nameFor(p.manager_id)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </main>
    </div>
  )
}

/**
 * Sets the recurring 1-on-1 with one person.
 *
 * Only offered from the manager side, because that is all the database allows:
 * being someone's report does not come with the authority to reschedule your own
 * review, the same reasoning as due dates belonging to whoever assigned the work.
 */
function ScheduleControl({ managerId, reportId, name, schedules, migrationNeeded, onSaved }: {
  managerId: string
  reportId: string
  name: string
  schedules: Schedule[]
  migrationNeeded: boolean
  onSaved: () => void
}) {
  const existing = schedules.find(s => s.manager_id === managerId && s.report_id === reportId)
  const [open, setOpen] = useState(false)
  const [cadence, setCadence] = useState<Cadence>(existing?.cadence ?? 'weekly')
  const [weekday, setWeekday] = useState(existing?.weekday ?? 3)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (migrationNeeded) return null

  const save = async () => {
    setSaving(true)
    setError(null)
    const { error: failure } = await upsertSchedule({
      id: existing?.id, manager_id: managerId, report_id: reportId, cadence, weekday, created_by: managerId,
    })
    if (failure) setError(describeScheduleError(failure))
    else { setOpen(false); onSaved() }
    setSaving(false)
  }

  const remove = async () => {
    if (!existing) return
    setSaving(true)
    setError(null)
    const { error: failure } = await deleteSchedule(existing.id)
    if (failure) setError(describeScheduleError(failure))
    else { setOpen(false); onSaved() }
    setSaving(false)
  }

  if (!open) {
    return (
      <button
        onClick={() => {
          setCadence(existing?.cadence ?? 'weekly')
          setWeekday(existing?.weekday ?? 3)
          setError(null)
          setOpen(true)
        }}
        className="text-[11px] font-bold uppercase tracking-wide text-steel-blue hover:text-deep-purple transition"
      >
        {existing ? `${WEEKDAYS[existing.weekday].slice(0, 3)} · ${existing.cadence === 'weekly' ? 'wkly' : 'fortn'}` : '+ Schedule'}
      </button>
    )
  }

  return (
    <div className="flex items-center gap-2 flex-wrap w-full">
      <select
        value={weekday}
        onChange={e => setWeekday(Number(e.target.value))}
        aria-label={`1-on-1 day with ${name}`}
        className="border border-light-gray rounded px-2 py-1 text-xs focus:border-steel-blue focus:outline-none"
      >
        {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
      </select>
      <select
        value={cadence}
        onChange={e => setCadence(e.target.value as Cadence)}
        aria-label={`1-on-1 cadence with ${name}`}
        className="border border-light-gray rounded px-2 py-1 text-xs focus:border-steel-blue focus:outline-none"
      >
        {(['weekly', 'fortnightly'] as Cadence[]).map(c => (
          <option key={c} value={c}>{CADENCE_LABEL[c]}</option>
        ))}
      </select>
      <button
        onClick={save}
        disabled={saving}
        className="bg-steel-blue text-white font-semibold px-2.5 py-1 rounded text-[11px] hover:bg-[#25698f] transition disabled:opacity-50"
      >
        {saving ? 'Saving...' : 'Save'}
      </button>
      {existing && (
        <button
          onClick={remove}
          disabled={saving}
          className="text-[11px] font-bold uppercase tracking-wide text-gray hover:text-coral-red transition"
        >
          Remove
        </button>
      )}
      <button
        onClick={() => setOpen(false)}
        className="text-[11px] font-bold uppercase tracking-wide text-gray hover:text-steel-blue transition"
      >
        Cancel
      </button>
      {error && <p className="text-[11px] text-coral-red w-full">{error}</p>}
    </div>
  )
}
