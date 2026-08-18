'use client'

import { use, useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import { useAuth, useMeeting, updateSegueNote, upsertSegueNote, updateHeadline, upsertHeadline, upsertScorecardItem, deleteScorecardItem, upsertIssue, deleteIssue, upsertTodo, deleteTodo, updateMeeting, updateSectionTimer, useCommitments, createCommitment, updateCommitment, setCommitmentStatus, describeCommitmentError, addParticipantByEmail, removeParticipant, useExtractedItems, importActionItems, acceptExtractedItem, rejectExtractedItem, useRocks, createRock, setRockCheckin, setRockStatus, deleteRock } from '@/lib/hooks'
import { SECTIONS, ROCK_STATUS_LABEL } from '@/lib/types'
import { quarterOf, quarterLabel, selectableQuarters } from '@/lib/quarters'
import type { ScorecardItem, Issue, Todo, SegueNote, Headline, SectionTimer, ParticipantRole, ExtractedItem, Rock, RockStatus } from '@/lib/types'

type Participant = {
  membershipId: string
  id: string
  full_name: string
  role: string
  email?: string
  removable: boolean
}

function initials(name?: string) {
  if (!name) return ''
  return name.split(' ').map(n => n[0]).slice(0,2).join('').toUpperCase()
}

function colorFor(key?: string) {
  if (!key) return 'hsl(220 60% 45%)'
  // simple deterministic hash to hue
  let h = 0
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0
  }
  const hue = h % 360
  // use HSL with decent saturation/lightness
  return `hsl(${hue} 60% 45%)`
}

function ParticipantLabel({ participant }: { participant: Participant }) {
  return (
    <div className="flex items-center justify-between">
      <div className="flex items-center gap-2">
        <div
          className="w-7 h-7 rounded-full flex items-center justify-center text-white font-semibold text-xs flex-shrink-0"
          style={{ backgroundColor: colorFor(participant.id || participant.full_name) }}
        >
          {initials(participant.full_name)}
        </div>
        <label className="text-[11px] font-bold uppercase tracking-wide text-medium-purple">
          {participant.full_name || participant.email}
        </label>
      </div>
      <span className="text-xs text-gray">{participant.role}</span>
    </div>
  )
}

export default function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { user } = useAuth()
  const { meeting, participants: memberships, participantsError, segueNotes, scorecardItems, headlines, issues, todos, timers, loading, refetch } = useMeeting(id)

  // Timer state
  const [masterStart, setMasterStart] = useState<number | null>(null)
  const [masterElapsed, setMasterElapsed] = useState(0)
  const [sectionElapsed, setSectionElapsed] = useState<number[]>([0, 0, 0, 0, 0])
  const [activeTimer, setActiveTimer] = useState<number | null>(null)
  const [completedSections, setCompletedSections] = useState<boolean[]>([false, false, false, false, false])
  const [expandedSection, setExpandedSection] = useState<number>(0)
  const [rating, setRating] = useState<number>(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Participant state — must stay above the loading early-return so hook order is stable
  const [addingEmail, setAddingEmail] = useState('')
  const [adding, setAdding] = useState(false)
  const [participantError, setParticipantError] = useState<string | null>(null)

  // Load saved timer state
  useEffect(() => {
    if (timers.length > 0) {
      const elapsed = SECTIONS.map((s, i) => {
        const t = timers.find((tm: SectionTimer) => tm.section_key === s.key)
        return t?.elapsed_seconds || 0
      })
      setSectionElapsed(elapsed)
      setCompletedSections(SECTIONS.map((s) => {
        const t = timers.find((tm: SectionTimer) => tm.section_key === s.key)
        return t?.completed || false
      }))
    }
    if (meeting?.rating) setRating(meeting.rating)
  }, [timers, meeting])

  // Master timer tick
  useEffect(() => {
    if (masterStart) {
      intervalRef.current = setInterval(() => {
        setMasterElapsed(Math.floor((Date.now() - masterStart) / 1000))
        if (activeTimer !== null) {
          setSectionElapsed(prev => {
            const next = [...prev]
            next[activeTimer] = prev[activeTimer] + 1
            return next
          })
        }
      }, 1000)
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [masterStart, activeTimer])

  // Save timer to DB periodically
  const saveTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  useEffect(() => {
    saveTimerRef.current = setInterval(() => {
      if (timers.length > 0) {
        SECTIONS.forEach((s, i) => {
          const t = timers.find((tm: SectionTimer) => tm.section_key === s.key)
          if (t) {
            updateSectionTimer(t.id, { elapsed_seconds: sectionElapsed[i], completed: completedSections[i] })
          }
        })
      }
    }, 10000) // save every 10s
    return () => { if (saveTimerRef.current) clearInterval(saveTimerRef.current) }
  }, [timers, sectionElapsed, completedSections])

  const startMeeting = () => {
    if (!masterStart) {
      setMasterStart(Date.now())
      setActiveTimer(0)
      setExpandedSection(0)
      if (meeting) updateMeeting(meeting.id, { status: 'active' })
    }
  }

  const toggleTimer = (i: number) => {
    if (activeTimer === i) {
      setActiveTimer(null)
    } else {
      if (!masterStart) startMeeting()
      setActiveTimer(i)
      setExpandedSection(i)
    }
  }

  const completeSection = (i: number) => {
    if (activeTimer === i) setActiveTimer(null)
    setCompletedSections(prev => {
      const next = [...prev]
      next[i] = true
      return next
    })
    // Save to DB
    const t = timers.find((tm: SectionTimer) => tm.section_key === SECTIONS[i].key)
    if (t) updateSectionTimer(t.id, { completed: true, elapsed_seconds: sectionElapsed[i] })
    // Auto-advance
    for (let j = i + 1; j < 5; j++) {
      if (!completedSections[j]) {
        setExpandedSection(j)
        setActiveTimer(j)
        return
      }
    }
  }

  const completeMeeting = async () => {
    if (meeting) {
      await updateMeeting(meeting.id, { status: 'completed', rating })
      // Save all timers
      for (const s of SECTIONS) {
        const i = SECTIONS.indexOf(s)
        const t = timers.find((tm: SectionTimer) => tm.section_key === s.key)
        if (t) await updateSectionTimer(t.id, { elapsed_seconds: sectionElapsed[i], completed: completedSections[i] })
      }
    }
  }

  const fmt = (seconds: number) => {
    const m = Math.floor(Math.abs(seconds) / 60)
    const s = Math.abs(seconds) % 60
    return `${m}:${String(s).padStart(2, '0')}`
  }

  const addParticipant = async () => {
    const email = addingEmail.trim()
    if (!email || adding) return
    setAdding(true)
    setParticipantError(null)
    const { error } = await addParticipantByEmail(id, email)
    if (error) {
      setParticipantError(error)
    } else {
      setAddingEmail('')
      await refetch()
    }
    setAdding(false)
  }

  if (loading || !meeting || !user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray">Loading meeting...</div>
      </div>
    )
  }

  const measurables = scorecardItems.filter((s: ScorecardItem) => s.item_type === 'measurable')
  const rocks = scorecardItems.filter((s: ScorecardItem) => s.item_type === 'rock')
  const carriedTodos = todos.filter((t: Todo) => !t.is_new)
  const newTodos = todos.filter((t: Todo) => t.is_new)

  // Participants come from meeting_participants — the same rows RLS keys access off.
  // Manager first, then report, then everyone else, so sections read consistently.
  const roleRank: Record<ParticipantRole, number> = { manager: 0, report: 1, participant: 2 }
  const roleLabel: Record<ParticipantRole, string> = { manager: 'Manager', report: 'Report', participant: 'Participant' }
  const memberParticipants: Participant[] = [...memberships]
    .sort((a, b) => roleRank[a.role] - roleRank[b.role])
    .map(m => ({
      membershipId: m.id,
      id: m.user_id,
      full_name: m.profile?.full_name || '',
      email: m.profile?.email,
      role: roleLabel[m.role],
      removable: m.role === 'participant',
    }))

  // Fall back to the manager/report pair when membership rows are unavailable
  // (e.g. supabase-participants.sql not applied yet) so the agenda still works.
  const fallbackParticipants: Participant[] = [
    ...(meeting.manager ? [{ membershipId: `manager-${meeting.manager.id}`, id: meeting.manager.id, full_name: meeting.manager.full_name, email: meeting.manager.email, role: 'Manager', removable: false }] : []),
    ...(meeting.report ? [{ membershipId: `report-${meeting.report.id}`, id: meeting.report.id, full_name: meeting.report.full_name, email: meeting.report.email, role: 'Report', removable: false }] : []),
  ]
  const participants = memberParticipants.length > 0 ? memberParticipants : fallbackParticipants

  return (
    <div className="min-h-screen">
      {/* Header */}
      <header className="bg-deep-purple px-6 py-4 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-4">
          <Link href="/" className="text-white/60 hover:text-white transition text-sm">&larr; Back</Link>
          <span className="text-white font-bold tracking-wider text-lg">DATAVATIONS</span>
          <span className="text-white/70 text-sm font-light">1-on-1 Agenda</span>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-steel-blue font-semibold text-sm">
            {new Date(meeting.meeting_date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' })}
          </span>
          <div className={`bg-white/10 rounded-lg px-3 py-1 text-white text-xl font-bold tabular-nums min-w-[80px] text-center ${masterElapsed > 1800 ? 'text-coral-red' : ''}`}>
            {fmt(masterElapsed)}
          </div>
        </div>
      </header>

      {/* Participants */}
      <div className="px-6 py-3 bg-white border-b border-light-gray">
        <div className="max-w-3xl mx-auto flex items-center gap-6 text-sm flex-wrap">
          {participants.map(p => (
            <div key={p.membershipId} className="flex items-center gap-3 group">
              <div className="w-9 h-9 rounded-full flex items-center justify-center text-white font-semibold text-sm flex-shrink-0" style={{ backgroundColor: colorFor(p.id || p.full_name) }}>
                {initials(p.full_name)}
              </div>
              <div>
                <div className="text-xs text-gray uppercase">{p.role}</div>
                <div className="font-semibold">{p.full_name || p.email}</div>
              </div>
              {p.removable && (
                <button
                  onClick={async () => {
                    setParticipantError(null)
                    const { error } = await removeParticipant(p.membershipId)
                    if (error) setParticipantError(error.message)
                    await refetch()
                  }}
                  title={`Remove ${p.full_name || p.email}`}
                  className="text-light-gray hover:text-coral-red transition opacity-0 group-hover:opacity-100"
                >
                  &times;
                </button>
              )}
            </div>
          ))}

          {/* The report seat is empty until someone is named */}
          {!meeting.report_id && (
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-light-gray flex-shrink-0" />
              <div>
                <div className="text-xs text-gray uppercase">Report</div>
                <div className="font-semibold text-gray">TBD</div>
              </div>
            </div>
          )}

          <div className="ml-auto flex items-center gap-2">
            {participantError && <span className="text-xs text-coral-red max-w-xs">{participantError}</span>}
            <input
              value={addingEmail}
              onChange={e => { setAddingEmail(e.target.value); setParticipantError(null) }}
              onKeyDown={e => { if (e.key === 'Enter') addParticipant() }}
              placeholder="Add participant email"
              className="border border-light-gray rounded px-3 py-1 text-sm focus:border-steel-blue focus:outline-none"
            />
            <button
              disabled={adding || !addingEmail.trim()}
              onClick={addParticipant}
              className="py-1 px-3 rounded bg-steel-blue text-white text-sm hover:bg-[#25698f] transition disabled:opacity-50"
            >
              {adding ? 'Adding...' : 'Add'}
            </button>
          </div>
        </div>
      </div>

      {/* Progress Bar */}
      <div className="flex gap-1 px-6 py-3 bg-white border-b border-light-gray">
        {SECTIONS.map((_, i) => (
          <div key={i} className={`flex-1 h-1 rounded-full transition-colors ${
            completedSections[i] ? 'bg-green' : i === expandedSection ? 'bg-steel-blue' : 'bg-light-gray'
          }`} />
        ))}
      </div>

      {/* Controls */}
      <div className="bg-white border-b border-light-gray px-6 py-3 flex items-center gap-3">
        {!masterStart ? (
          <button onClick={startMeeting} className="bg-steel-blue text-white font-semibold px-5 py-2 rounded-lg hover:bg-[#25698f] transition text-sm">
            Start Meeting
          </button>
        ) : (
          <span className="text-sm text-green font-semibold">Meeting in progress</span>
        )}
        <div className="flex-1" />
        {masterStart && (
          <button onClick={completeMeeting} className="bg-green text-white font-semibold px-5 py-2 rounded-lg hover:bg-[#2d8a47] transition text-sm">
            Complete Meeting
          </button>
        )}
      </div>

      {/* Sections */}
      <main className="max-w-3xl mx-auto px-4 py-6 space-y-4">
        {participantsError && (
          <div className="bg-amber-light text-[#e67e22] text-sm p-3 rounded-lg">
            {participantsError} Showing the manager and report only until then.
          </div>
        )}
        {/* Action items from the notetaker → review queue */}
        <div className="bg-white rounded-xl border border-light-gray p-6">
          <h2 className="text-lg font-bold text-deep-purple mb-2">Import Next Steps</h2>
          <p className="text-sm text-gray mb-4">
            Paste the action items Granola or Gemini already produced, one per line. Owners and due
            dates are read where they're stated, and anything already on this agenda is flagged as a
            duplicate. Nothing lands on the agenda until you accept it.
          </p>
          <ActionItemImport
            meetingId={id}
            meetingDate={meeting.meeting_date}
            participants={participants}
            currentUserId={user.id}
            onAccepted={refetch}
          />
        </div>

        {/* Weekly Commitments */}
        <div className="bg-white rounded-xl border border-light-gray p-6">
          <h2 className="text-lg font-bold text-deep-purple mb-2">Weekly Commitments</h2>
          <p className="text-sm text-gray mb-4">Float tasks during the week and notify assignees via email or Slack.</p>
          <WeeklyCommitments meetingId={id} participants={participants} currentUserId={user.id} />
        </div>
        {SECTIONS.map((section, i) => (
          <div key={section.key} className={`bg-white rounded-xl border transition overflow-hidden ${
            completedSections[i] ? 'border-light-gray opacity-70' :
            i === expandedSection ? 'border-steel-blue shadow-md' : 'border-light-gray'
          }`}>
            {/* Section Header */}
            <div
              className="flex items-center p-4 cursor-pointer gap-3"
              onClick={() => setExpandedSection(expandedSection === i ? -1 : i)}
            >
              <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white font-bold text-sm flex-shrink-0 ${
                completedSections[i] ? 'bg-green' : i === expandedSection ? 'bg-steel-blue' : 'bg-medium-purple'
              }`}>
                {completedSections[i] ? '✓' : i + 1}
              </div>
              <div className="flex-1">
                <div className="text-[11px] font-bold uppercase tracking-wider text-steel-blue">{section.label}</div>
                <div className="text-base font-semibold text-deep-purple">{section.title}</div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`font-semibold tabular-nums ${sectionElapsed[i] > section.allotted ? 'text-coral-red' : 'text-near-black'}`}>
                  {fmt(sectionElapsed[i])}
                </span>
                <span className="text-xs text-gray">/ {fmt(section.allotted)}</span>
                <button
                  onClick={e => { e.stopPropagation(); toggleTimer(i) }}
                  className={`w-8 h-8 rounded-full border-2 flex items-center justify-center text-sm transition flex-shrink-0 ${
                    activeTimer === i ? 'bg-steel-blue border-steel-blue text-white' : 'border-steel-blue text-steel-blue hover:bg-steel-blue/10'
                  }`}
                >
                  {activeTimer === i ? '⏸' : '▶'}
                </button>
                <button
                  onClick={e => { e.stopPropagation(); completeSection(i) }}
                  className={`w-8 h-8 rounded-full border-2 flex items-center justify-center text-sm transition flex-shrink-0 ${
                    completedSections[i] ? 'bg-green border-green text-white' : 'border-light-gray text-light-gray hover:border-green hover:text-green'
                  }`}
                >
                  ✓
                </button>
              </div>
            </div>

            {/* Section Body */}
            {expandedSection === i && (
              <div className="px-4 pb-4 pl-[60px]">
                <div className="w-14 h-[3px] bg-steel-blue rounded mb-3" />

                {/* ── Segue ── */}
                {section.key === 'segue' && (
                  <div className="space-y-3">
                    <p className="text-sm text-gray font-condensed leading-relaxed">
                      Each person shares one personal and one professional win from the past week.
                    </p>

                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {participants.map(p => {
                        const note = segueNotes.find((n: SegueNote) => n.user_id === p.id)
                        // Editable by any participant — this is a single shared agenda
                        const saveWin = async (field: 'personal_win' | 'professional_win', val: string) => {
                          if ((note?.[field] || '') === val) return
                          if (note?.id) {
                            await updateSegueNote(note.id, { [field]: val })
                          } else {
                            await upsertSegueNote({ meeting_id: id, user_id: p.id, [field]: val })
                            await refetch() // pick up the new row id so the next edit updates instead of inserting
                          }
                        }
                        return (
                          <div key={p.id} className="space-y-2">
                            <ParticipantLabel participant={p} />
                            <textarea
                              defaultValue={note?.personal_win || ''}
                              placeholder="Personal win..."
                              onBlur={e => saveWin('personal_win', e.target.value)}
                              className="w-full border border-light-gray rounded-lg px-3 py-2 text-sm resize-none focus:border-steel-blue focus:outline-none"
                              rows={2}
                            />
                            <textarea
                              defaultValue={note?.professional_win || ''}
                              placeholder="Professional win..."
                              onBlur={e => saveWin('professional_win', e.target.value)}
                              className="w-full border border-light-gray rounded-lg px-3 py-2 text-sm resize-none focus:border-steel-blue focus:outline-none"
                              rows={2}
                            />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* ── Scorecard & Rocks ── */}
                {section.key === 'scorecard' && (
                  <div className="space-y-4">
                    <p className="text-sm text-gray font-condensed leading-relaxed">
                      Binary only: on track or off track. If something is off track, drop it to Issues.
                    </p>
                    <div>
                      <label className="text-[11px] font-bold uppercase tracking-wide text-medium-purple mb-2 block">Scorecard Measurables</label>
                      <ScorecardList items={measurables} meetingId={id} type="measurable" onUpdate={refetch} />
                    </div>
                    <RockList
                      meetingId={id}
                      meetingDate={meeting.meeting_date}
                      participants={participants}
                      currentUserId={user.id}
                      legacyRocks={rocks}
                    />
                  </div>
                )}

                {/* ── Headlines ── */}
                {section.key === 'headlines' && (
                  <div className="space-y-3">
                    <p className="text-sm text-gray font-condensed leading-relaxed">
                      Employee, customer, or operational news worth flagging — good or bad.
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {participants.map(p => {
                        const headline = headlines.find((h: Headline) => h.user_id === p.id)
                        const saveHeadline = async (val: string) => {
                          if ((headline?.content || '') === val) return
                          if (headline?.id) {
                            await updateHeadline(headline.id, val)
                          } else {
                            await upsertHeadline({ meeting_id: id, user_id: p.id, content: val })
                            await refetch() // pick up the new row id so the next edit updates instead of inserting
                          }
                        }
                        return (
                          <div key={p.id} className="space-y-2">
                            <ParticipantLabel participant={p} />
                            <textarea
                              defaultValue={headline?.content || ''}
                              placeholder="News and updates..."
                              onBlur={e => saveHeadline(e.target.value)}
                              className="w-full border border-light-gray rounded-lg px-3 py-2 text-sm resize-none focus:border-steel-blue focus:outline-none"
                              rows={3}
                            />
                          </div>
                        )
                      })}
                    </div>
                  </div>
                )}

                {/* ── IDS Issues ── */}
                {section.key === 'ids' && (
                  <div className="space-y-3">
                    <p className="text-sm text-gray font-condensed leading-relaxed">
                      Prioritize top 2-3 issues. <strong>Identify</strong> root cause, <strong>Discuss</strong> until understood, <strong>Solve</strong> with a concrete to-do.
                    </p>
                    <IssuesList issues={issues} meetingId={id} onUpdate={refetch} />
                  </div>
                )}

                {/* ── To-Dos & Wrap ── */}
                {section.key === 'todos' && (
                  <div className="space-y-4">
                    <p className="text-sm text-gray font-condensed leading-relaxed">
                      Review last week&apos;s to-dos: done or not done. Confirm new to-dos from today.
                    </p>
                    {carriedTodos.length > 0 && (
                      <div>
                        <label className="text-[11px] font-bold uppercase tracking-wide text-medium-purple mb-2 block">Carried Forward</label>
                        <TodoList todos={carriedTodos} meetingId={id} isNew={false} onUpdate={refetch} />
                      </div>
                    )}
                    <div>
                      <label className="text-[11px] font-bold uppercase tracking-wide text-medium-purple mb-2 block">New To-Dos</label>
                      <TodoList todos={newTodos} meetingId={id} isNew={true} onUpdate={refetch} />
                    </div>
                    {/* Rating */}
                    <div className="flex items-center gap-3 pt-2">
                      <span className="text-sm text-gray">Rate this meeting:</span>
                      <div className="flex gap-1">
                        {[1,2,3,4,5,6,7,8,9,10].map(n => (
                          <button
                            key={n}
                            onClick={() => { setRating(n); updateMeeting(id, { rating: n }) }}
                            className={`w-7 h-7 rounded text-xs font-bold transition ${
                              n <= rating ? 'bg-steel-blue text-white border border-steel-blue' : 'border border-light-gray text-gray hover:border-steel-blue'
                            }`}
                          >
                            {n}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </main>
    </div>
  )
}

// ── Scorecard List Component ──
function ScorecardList({ items, meetingId, type, onUpdate }: {
  items: ScorecardItem[], meetingId: string, type: 'measurable' | 'rock', onUpdate: () => void
}) {
  const addItem = async () => {
    await upsertScorecardItem({ meeting_id: meetingId, item_type: type, name: '', on_track: true, sort_order: items.length })
    onUpdate()
  }

  return (
    <div className="space-y-2">
      {items.map(item => (
        <div key={item.id} className="flex items-center gap-2">
          <input
            type="text"
            defaultValue={item.name}
            placeholder={type === 'measurable' ? 'Measurable name...' : 'Rock name...'}
            onBlur={e => upsertScorecardItem({ id: item.id, meeting_id: meetingId, name: e.target.value })}
            className="flex-1 border border-light-gray rounded-lg px-3 py-2 text-sm focus:border-steel-blue focus:outline-none"
          />
          <button
            onClick={() => { upsertScorecardItem({ id: item.id, meeting_id: meetingId, on_track: !item.on_track }); onUpdate() }}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold min-w-[80px] text-center transition ${
              item.on_track ? 'bg-green-light text-green' : 'bg-red-light text-coral-red'
            }`}
          >
            {item.on_track ? 'On Track' : 'Off Track'}
          </button>
          <button onClick={() => { deleteScorecardItem(item.id); onUpdate() }} className="text-light-gray hover:text-coral-red transition text-lg">&times;</button>
        </div>
      ))}
      <button onClick={addItem} className="w-full border border-dashed border-light-gray rounded-lg py-2 text-xs text-gray hover:border-steel-blue hover:text-steel-blue transition">
        + Add {type}
      </button>
    </div>
  )
}

// ── Issues List Component ──
function IssuesList({ issues, meetingId, onUpdate }: {
  issues: Issue[], meetingId: string, onUpdate: () => void
}) {
  const priorities = ['H', 'M', 'L'] as const
  const priorityColors = { H: 'bg-red-light text-[#c0392b]', M: 'bg-amber-light text-[#e67e22]', L: 'bg-green-light text-green' }

  const cyclePriority = (issue: Issue) => {
    const idx = priorities.indexOf(issue.priority)
    const next = priorities[(idx + 1) % 3]
    upsertIssue({ id: issue.id, meeting_id: meetingId, priority: next })
    onUpdate()
  }

  const addIssue = async () => {
    await upsertIssue({ meeting_id: meetingId, description: '', priority: 'H', sort_order: issues.length })
    onUpdate()
  }

  return (
    <div className="space-y-2">
      {issues.map(issue => (
        <div key={issue.id} className="flex items-start gap-2">
          <button
            onClick={() => cyclePriority(issue)}
            className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 mt-1 ${priorityColors[issue.priority]}`}
            title="Click to cycle priority"
          >
            {issue.priority}
          </button>
          <div className="flex-1 space-y-1">
            <input
              type="text"
              defaultValue={issue.description}
              placeholder="Issue description..."
              onBlur={e => upsertIssue({ id: issue.id, meeting_id: meetingId, description: e.target.value })}
              className="w-full border border-light-gray rounded-lg px-3 py-2 text-sm focus:border-steel-blue focus:outline-none"
            />
            <input
              type="text"
              defaultValue={issue.resolution}
              placeholder="Resolution / to-do → owner..."
              onBlur={e => upsertIssue({ id: issue.id, meeting_id: meetingId, resolution: e.target.value })}
              className="w-full border border-light-gray rounded-lg px-3 py-1.5 text-xs text-gray focus:border-steel-blue focus:outline-none focus:text-near-black font-condensed"
            />
          </div>
          <button onClick={() => { deleteIssue(issue.id); onUpdate() }} className="text-light-gray hover:text-coral-red transition text-lg mt-1">&times;</button>
        </div>
      ))}
      <button onClick={addIssue} className="w-full border border-dashed border-light-gray rounded-lg py-2 text-xs text-gray hover:border-steel-blue hover:text-steel-blue transition">
        + Add issue
      </button>
    </div>
  )
}

// ── Todo List Component ──
function TodoList({ todos, meetingId, isNew, onUpdate }: {
  todos: Todo[], meetingId: string, isNew: boolean, onUpdate: () => void
}) {
  const addTodo = async () => {
    await upsertTodo({ meeting_id: meetingId, text: '', owner: '', done: false, is_new: isNew, sort_order: todos.length })
    onUpdate()
  }

  return (
    <div className="space-y-2">
      {todos.map(todo => (
        <div key={todo.id} className="flex items-center gap-2">
          <button
            onClick={() => { upsertTodo({ id: todo.id, meeting_id: meetingId, done: !todo.done }); onUpdate() }}
            className={`w-6 h-6 rounded flex items-center justify-center text-xs border-2 flex-shrink-0 transition ${
              todo.done ? 'bg-green border-green text-white' : 'border-light-gray text-transparent hover:border-green'
            }`}
          >
            ✓
          </button>
          <input
            type="text"
            defaultValue={todo.text}
            placeholder={isNew ? 'New to-do...' : 'Carried to-do...'}
            onBlur={e => upsertTodo({ id: todo.id, meeting_id: meetingId, text: e.target.value })}
            className={`flex-1 border border-light-gray rounded-lg px-3 py-2 text-sm focus:border-steel-blue focus:outline-none ${todo.done ? 'line-through text-gray' : ''}`}
          />
          <input
            type="text"
            defaultValue={todo.owner}
            placeholder="Owner"
            onBlur={e => upsertTodo({ id: todo.id, meeting_id: meetingId, owner: e.target.value })}
            className="w-24 border border-light-gray rounded-lg px-2 py-2 text-xs text-gray focus:border-steel-blue focus:outline-none focus:text-near-black"
          />
          <button onClick={() => { deleteTodo(todo.id); onUpdate() }} className="text-light-gray hover:text-coral-red transition text-lg">&times;</button>
        </div>
      ))}
      <button onClick={addTodo} className="w-full border border-dashed border-light-gray rounded-lg py-2 text-xs text-gray hover:border-steel-blue hover:text-steel-blue transition">
        + Add to-do
      </button>
    </div>
  )
}

// ── Transcript extraction + review queue ──
function ActionItemImport({ meetingId, meetingDate, participants, currentUserId, onAccepted }: {
  meetingId: string, meetingDate: string, participants: Participant[], currentUserId: string, onAccepted: () => void
}) {
  const { items, loading, error: loadError, refetch } = useExtractedItems(meetingId)
  const [pasted, setPasted] = useState('')
  const [target, setTarget] = useState<'commitment' | 'todo' | 'issue'>('commitment')
  const [extracting, setExtracting] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const nameFor = (userId: string | null) => {
    if (!userId) return 'Unassigned'
    const p = participants.find(x => x.id === userId)
    return p?.full_name || p?.email || 'Unknown'
  }

  const runImport = async () => {
    if (!pasted.trim() || extracting) return
    setExtracting(true)
    setActionError(null)
    setNotice(null)

    const { count, duplicates, error } = await importActionItems({
      meetingId,
      rawText: pasted,
      target,
      // Only real participants can own an item, so an unrecognised name stays
      // unassigned rather than being guessed at.
      participants: participants.map(p => ({ id: p.id, full_name: p.full_name, email: p.email })),
      userId: currentUserId,
      referenceDate: meetingDate,
    })

    if (error) {
      setActionError(error)
    } else if (count === 0) {
      setNotice("Nothing read from that. Put one action item per line — bullets, numbers and checkboxes are all fine.")
    } else {
      setPasted('')
      setNotice(
        `${count} item${count === 1 ? '' : 's'} to review` +
          (duplicates > 0 ? ` · ${duplicates} flagged as already on the agenda` : ''),
      )
      await refetch()
    }
    setExtracting(false)
  }

  const accept = async (item: ExtractedItem) => {
    setBusyId(item.id)
    setActionError(null)
    const { error } = await acceptExtractedItem(item, currentUserId)
    if (error) setActionError(error)
    await refetch()
    onAccepted()
    setBusyId(null)
  }

  const reject = async (item: ExtractedItem) => {
    setBusyId(item.id)
    setActionError(null)
    const { error } = await rejectExtractedItem(item.id, currentUserId)
    if (error) setActionError(error)
    await refetch()
    setBusyId(null)
  }

  const problem = actionError || loadError
  const targetLabel: Record<ExtractedItem['target'], string> = {
    todo: 'TO-DO', commitment: 'COMMITMENT', issue: 'ISSUE',
  }

  return (
    <div>
      {problem && <div className="bg-red-light text-coral-red text-sm p-3 rounded-lg mb-4">{problem}</div>}
      {notice && <div className="bg-[#e8f0fe] text-steel-blue text-sm p-3 rounded-lg mb-4">{notice}</div>}

      {loading ? (
        <p className="text-sm text-gray mb-4">Loading review queue...</p>
      ) : items.length > 0 && (
        <div className="space-y-2 mb-4">
          <label className="text-[11px] font-bold uppercase tracking-wide text-medium-purple block">
            Pending review ({items.length})
          </label>
          {items.map(item => (
            <div key={item.id} className="border border-light-gray rounded-lg p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1 flex-wrap">
                    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-[#e8f0fe] text-steel-blue">
                      {targetLabel[item.target]}
                    </span>
                    {!item.owner_id && (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-light-gray text-gray">
                        NO OWNER READ
                      </span>
                    )}
                    {item.duplicate_of_id && (
                      <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-light text-[#e67e22]">
                        POSSIBLE DUPLICATE
                      </span>
                    )}
                  </div>
                  <div className="font-semibold text-sm text-near-black">{item.title}</div>
                  <div className="text-xs text-gray mt-0.5">
                    {nameFor(item.owner_id)}{item.due_date ? ` · Due ${item.due_date}` : ''}
                  </div>
                  {item.evidence && (
                    <blockquote className="text-xs text-gray italic mt-2 pl-2 border-l-2 border-light-gray">
                      &ldquo;{item.evidence}&rdquo;
                    </blockquote>
                  )}
                </div>
                <div className="flex flex-col gap-1 flex-shrink-0">
                  <button
                    onClick={() => accept(item)}
                    disabled={busyId === item.id}
                    className="bg-green text-white text-xs font-semibold px-3 py-1 rounded hover:bg-[#2d8a47] transition disabled:opacity-50"
                  >
                    Accept
                  </button>
                  <button
                    onClick={() => reject(item)}
                    disabled={busyId === item.id}
                    className="border border-light-gray text-gray text-xs font-semibold px-3 py-1 rounded hover:border-coral-red hover:text-coral-red transition disabled:opacity-50"
                  >
                    Reject
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <textarea
        value={pasted}
        onChange={e => setPasted(e.target.value)}
        placeholder={'Paste action items, one per line:\n- Sam: send the Q3 scorecard by Friday\n- Ashley to draft the hiring plan\n- Book the vendor call'}
        rows={5}
        className="w-full border border-light-gray rounded-lg px-3 py-2 text-sm resize-y focus:border-steel-blue focus:outline-none"
      />
      <div className="flex items-center justify-between mt-2 gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <label className="text-[11px] font-bold uppercase tracking-wide text-gray">Add as</label>
          <select
            value={target}
            onChange={e => setTarget(e.target.value as 'commitment' | 'todo' | 'issue')}
            className="border border-light-gray rounded-lg px-2 py-1.5 text-sm focus:border-steel-blue focus:outline-none"
          >
            <option value="commitment">Commitments</option>
            <option value="todo">To-dos</option>
            <option value="issue">Issues</option>
          </select>
        </div>
        <button
          onClick={runImport}
          disabled={extracting || !pasted.trim()}
          className="bg-medium-purple text-white font-semibold px-4 py-2 rounded-lg text-sm hover:bg-deep-purple transition disabled:opacity-50"
        >
          {extracting ? 'Reading...' : 'Review next steps'}
        </button>
      </div>
    </div>
  )
}

function WeeklyCommitments({ meetingId, participants, currentUserId }: {
  meetingId: string, participants: Participant[], currentUserId: string
}) {
  const { commitments, loading, error: loadError, refetch } = useCommitments(meetingId)
  const [title, setTitle] = useState('')
  const [assignee, setAssignee] = useState('')
  const [due, setDue] = useState('')
  const [notifyEmail, setNotifyEmail] = useState(true)
  const [notifySlack, setNotifySlack] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Default the assignee to the current user once the participant list resolves
  useEffect(() => {
    if (assignee || participants.length === 0) return
    setAssignee(participants.some(p => p.id === currentUserId) ? currentUserId : participants[0].id)
  }, [participants, assignee, currentUserId])

  const nameFor = (userId: string) => {
    const p = participants.find(x => x.id === userId)
    return p?.full_name || p?.email || 'Unassigned'
  }

  const create = async () => {
    if (!title.trim() || !assignee || saving) return
    setSaving(true)
    setSaveError(null)
    const { error } = await createCommitment({
      meeting_id: meetingId,
      creator_id: currentUserId,
      assignee_id: assignee,
      title: title.trim(),
      due_date: due || null,
      notify_email: notifyEmail,
      notify_slack: notifySlack,
    })
    if (error) {
      setSaveError(describeCommitmentError(error))
    } else {
      setTitle('')
      setDue('')
      await refetch()
    }
    setSaving(false)
  }

  const toggleDone = async (id: string, status: 'open' | 'done') => {
    // setCommitmentStatus, not updateCommitment: it stamps completed_at, which
    // is what the tracker's "done this week" list reads.
    const { error } = await setCommitmentStatus(id, status === 'done' ? 'open' : 'done')
    if (error) setSaveError(describeCommitmentError(error))
    await refetch()
  }

  const problem = saveError || loadError

  return (
    <div>
      {problem && (
        <div className="bg-red-light text-coral-red text-sm p-3 rounded-lg mb-4">{problem}</div>
      )}
      <div className="space-y-2 mb-4">
        {loading ? (
          <p className="text-sm text-gray">Loading commitments...</p>
        ) : commitments.length === 0 ? (
          <p className="text-sm text-light-gray italic">No commitments yet.</p>
        ) : commitments.map(c => (
          <div key={c.id} className="flex items-center gap-3 p-3 border border-light-gray rounded-lg">
            <button
              onClick={() => toggleDone(c.id, c.status)}
              className={`w-6 h-6 rounded flex items-center justify-center text-xs border-2 flex-shrink-0 transition ${
                c.status === 'done' ? 'bg-green border-green text-white' : 'border-light-gray text-transparent hover:border-green'
              }`}
              title={c.status === 'done' ? 'Mark as open' : 'Mark as done'}
            >
              ✓
            </button>
            <div className="flex-1 min-w-0">
              <div className={`font-semibold text-sm ${c.status === 'done' ? 'line-through text-gray' : 'text-near-black'}`}>{c.title}</div>
              <div className="text-xs text-gray">
                {nameFor(c.assignee_id)} · Due {c.due_date || '—'}
                {c.notify_email && <span> · email</span>}
                {c.notify_slack && <span> · slack</span>}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <input
          className="md:col-span-2 border border-light-gray rounded-lg px-3 py-2 text-sm focus:border-steel-blue focus:outline-none"
          placeholder="Commitment title"
          value={title}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') create() }}
        />
        <input
          type="date"
          className="border border-light-gray rounded-lg px-3 py-2 text-sm focus:border-steel-blue focus:outline-none"
          value={due}
          onChange={e => setDue(e.target.value)}
        />
        <select
          className="md:col-span-2 border border-light-gray rounded-lg px-3 py-2 text-sm focus:border-steel-blue focus:outline-none"
          value={assignee}
          onChange={e => setAssignee(e.target.value)}
        >
          {participants.map(p => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
        </select>
        <div className="flex items-center gap-3 text-sm text-gray">
          <label className="flex items-center gap-1"><input type="checkbox" checked={notifyEmail} onChange={e => setNotifyEmail(e.target.checked)} /> Email</label>
          <label className="flex items-center gap-1"><input type="checkbox" checked={notifySlack} onChange={e => setNotifySlack(e.target.checked)} /> Slack</label>
        </div>
        <div className="md:col-span-3 flex justify-end">
          <button
            onClick={create}
            disabled={saving || !title.trim()}
            className="bg-steel-blue text-white font-semibold px-4 py-2 rounded-lg text-sm hover:bg-[#25698f] transition disabled:opacity-50"
          >
            {saving ? 'Adding...' : 'Add Commitment'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Quarterly Rocks for everyone in this meeting.
 *
 * Rocks are read from the rocks table for this meeting's quarter, never copied on
 * to the agenda. That is what makes them appear in *every* agenda in the quarter,
 * including one created after a skipped week, and it means editing a Rock is a
 * single change rather than a dozen rows that drift apart.
 */
function RockList({
  meetingId, meetingDate, participants, currentUserId, legacyRocks,
}: {
  meetingId: string
  meetingDate: string
  participants: Participant[]
  currentUserId: string
  legacyRocks: ScorecardItem[]
}) {
  const quarter = quarterOf(meetingDate)
  const ownerIds = participants.map(p => p.id).filter(Boolean)
  const { rocks, loading, error, refetch } = useRocks(meetingId, ownerIds, quarter)

  const [title, setTitle] = useState('')
  const [ownerId, setOwnerId] = useState(currentUserId)
  const [forQuarter, setForQuarter] = useState(quarter)
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const nameFor = (id: string) => {
    const p = participants.find(x => x.id === id)
    return p?.full_name || p?.email || 'Unknown'
  }

  const add = async () => {
    if (!title.trim() || saving) return
    setSaving(true)
    setActionError(null)
    const { error: createError } = await createRock({
      owner_id: ownerId,
      title: title.trim(),
      quarter: forQuarter,
      created_by: currentUserId,
    })
    if (createError) setActionError(createError)
    else {
      setTitle('')
      await refetch()
    }
    setSaving(false)
  }

  const pulse = async (rock: Rock, onTrack: boolean) => {
    setActionError(null)
    const { error: checkinError } = await setRockCheckin({
      rock_id: rock.id,
      meeting_id: meetingId,
      on_track: onTrack,
      recorded_by: currentUserId,
    })
    if (checkinError) setActionError(checkinError)
    await refetch()
  }

  const changeStatus = async (rock: Rock, status: RockStatus) => {
    setActionError(null)
    const { error: statusError } = await setRockStatus(rock.id, status)
    if (statusError) setActionError(statusError)
    await refetch()
  }

  const remove = async (rock: Rock) => {
    setActionError(null)
    const { error: deleteError } = await deleteRock(rock.id)
    if (deleteError) setActionError(deleteError)
    await refetch()
  }

  const problem = actionError || error
  const byOwner = ownerIds
    .map(id => ({ id, rocks: rocks.filter(r => r.owner_id === id) }))
    .filter(group => group.rocks.length > 0)

  return (
    <div>
      <div className="flex items-baseline justify-between mb-2">
        <label className="text-[11px] font-bold uppercase tracking-wide text-medium-purple">
          Quarterly Rocks
        </label>
        <span className="text-[11px] text-gray">{quarterLabel(quarter)}</span>
      </div>

      {problem && (
        <div className="bg-red-light text-coral-red text-sm p-3 rounded-lg mb-3">{problem}</div>
      )}

      {legacyRocks.length > 0 && (
        <div className="bg-amber-light text-[#e67e22] text-xs p-3 rounded-lg mb-3">
          {legacyRocks.length} Rock{legacyRocks.length === 1 ? '' : 's'} on this agenda predate
          quarterly Rocks and are shown below. Re-add them above to have them carry across the
          whole quarter.
        </div>
      )}

      {loading ? (
        <p className="text-sm text-gray mb-3">Loading Rocks...</p>
      ) : byOwner.length === 0 ? (
        <p className="text-sm text-gray mb-3">
          No Rocks for {quarterLabel(quarter)} yet. A Rock added here shows up in every agenda for
          that person this quarter.
        </p>
      ) : (
        <div className="space-y-3 mb-4">
          {byOwner.map(group => (
            <div key={group.id}>
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray mb-1">
                {nameFor(group.id)}
              </div>
              <div className="space-y-2">
                {group.rocks.map(rock => {
                  const onTrack = rock.checkin ? rock.checkin.on_track : rock.status !== 'off_track'
                  const closed = rock.status === 'done' || rock.status === 'dropped'
                  return (
                    <div
                      key={rock.id}
                      className={`flex items-center gap-3 p-3 border rounded-lg ${
                        closed
                          ? 'border-light-gray bg-[#fafafa]'
                          : onTrack
                            ? 'border-light-gray bg-white'
                            : 'border-coral-red bg-red-light'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <div className={`font-semibold text-sm ${closed ? 'line-through text-gray' : 'text-near-black'}`}>
                          {rock.title}
                        </div>
                        <div className="text-xs text-gray">
                          {ROCK_STATUS_LABEL[rock.status]}
                          {!rock.checkin && !closed && ' · no pulse this week yet'}
                        </div>
                      </div>

                      {!closed && (
                        <div className="flex gap-1 flex-shrink-0">
                          {/* This week's pulse, recorded per meeting so the trend
                              across the quarter survives rather than one flag. */}
                          <button
                            onClick={() => pulse(rock, true)}
                            className={`text-[10px] font-bold px-2 py-1 rounded border transition ${
                              rock.checkin && onTrack
                                ? 'bg-green border-green text-white'
                                : 'border-light-gray text-gray hover:border-green'
                            }`}
                          >
                            ON TRACK
                          </button>
                          <button
                            onClick={() => pulse(rock, false)}
                            className={`text-[10px] font-bold px-2 py-1 rounded border transition ${
                              rock.checkin && !onTrack
                                ? 'bg-coral-red border-coral-red text-white'
                                : 'border-light-gray text-gray hover:border-coral-red'
                            }`}
                          >
                            OFF
                          </button>
                        </div>
                      )}

                      <select
                        value={rock.status}
                        onChange={e => changeStatus(rock, e.target.value as RockStatus)}
                        className="border border-light-gray rounded px-2 py-1 text-xs focus:border-steel-blue focus:outline-none flex-shrink-0"
                      >
                        {(['on_track', 'off_track', 'done', 'dropped'] as RockStatus[]).map(st => (
                          <option key={st} value={st}>{ROCK_STATUS_LABEL[st]}</option>
                        ))}
                      </select>

                      <button
                        onClick={() => remove(rock)}
                        title="Remove this Rock"
                        className="text-gray hover:text-coral-red transition text-sm flex-shrink-0"
                      >
                        ×
                      </button>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 items-end flex-wrap">
        <input
          value={title}
          onChange={e => setTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') add() }}
          placeholder="Rock for the quarter..."
          className="flex-1 min-w-[180px] border border-light-gray rounded-lg px-3 py-2 text-sm focus:border-steel-blue focus:outline-none"
        />
        <select
          value={ownerId}
          onChange={e => setOwnerId(e.target.value)}
          className="border border-light-gray rounded-lg px-2 py-2 text-sm focus:border-steel-blue focus:outline-none"
        >
          {participants.map(p => (
            <option key={p.id} value={p.id}>{p.full_name || p.email}</option>
          ))}
        </select>
        <select
          value={forQuarter}
          onChange={e => setForQuarter(e.target.value)}
          className="border border-light-gray rounded-lg px-2 py-2 text-sm focus:border-steel-blue focus:outline-none"
        >
          {selectableQuarters(meetingDate).map(q => (
            <option key={q} value={q}>{quarterLabel(q)}</option>
          ))}
        </select>
        <button
          onClick={add}
          disabled={saving || !title.trim()}
          className="bg-medium-purple text-white font-semibold px-4 py-2 rounded-lg text-sm hover:bg-deep-purple transition disabled:opacity-50"
        >
          {saving ? 'Adding...' : 'Add Rock'}
        </button>
      </div>

      {legacyRocks.length > 0 && (
        <div className="mt-3">
          <ScorecardList items={legacyRocks} meetingId={meetingId} type="rock" onUpdate={refetch} />
        </div>
      )}
    </div>
  )
}
