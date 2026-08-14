'use client'

import { use, useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import { useAuth, useMeeting, updateSegueNote, updateHeadline, upsertScorecardItem, deleteScorecardItem, upsertIssue, deleteIssue, upsertTodo, deleteTodo, updateMeeting, updateSectionTimer } from '@/lib/hooks'
import { SECTIONS } from '@/lib/types'
import type { ScorecardItem, Issue, Todo, SegueNote, Headline, SectionTimer } from '@/lib/types'

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

export default function MeetingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params)
  const { user } = useAuth()
  const { meeting, segueNotes, scorecardItems, headlines, issues, todos, timers, loading, refetch } = useMeeting(id)

  // Timer state
  const [masterStart, setMasterStart] = useState<number | null>(null)
  const [masterElapsed, setMasterElapsed] = useState(0)
  const [sectionElapsed, setSectionElapsed] = useState<number[]>([0, 0, 0, 0, 0])
  const [activeTimer, setActiveTimer] = useState<number | null>(null)
  const [completedSections, setCompletedSections] = useState<boolean[]>([false, false, false, false, false])
  const [expandedSection, setExpandedSection] = useState<number>(0)
  const [rating, setRating] = useState<number>(0)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

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

  if (loading || !meeting || !user) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-gray">Loading meeting...</div>
      </div>
    )
  }

  const managerSegue = segueNotes.find((n: SegueNote) => n.user_id === meeting.manager_id)
  const reportSegue = segueNotes.find((n: SegueNote) => n.user_id === meeting.report_id)
  const managerHeadline = headlines.find((h: Headline) => h.user_id === meeting.manager_id)
  const reportHeadline = headlines.find((h: Headline) => h.user_id === meeting.report_id)
  const amManager = user.id === meeting.manager_id
  const amReport = user.id === meeting.report_id
  const [extraProfiles, setExtraProfiles] = useState<{ id: string; full_name: string; email: string }[]>([])
  
  // derive participants from meeting + any segue/headline user_ids
  useEffect(() => {
    const ids = new Set<string>()
    if (meeting.manager_id) ids.add(meeting.manager_id)
    if (meeting.report_id) ids.add(meeting.report_id)
    segueNotes.forEach(n => ids.add(n.user_id))
    headlines.forEach(h => ids.add(h.user_id))
    // remove manager/report which are already present in meeting
    const extra = Array.from(ids).filter(id => id !== meeting.manager_id && id !== meeting.report_id)
    if (extra.length === 0) {
      setExtraProfiles([])
      return
    }
    ;(async () => {
      try {
        const { createClient } = await import('@/lib/supabase')
        const supabase = createClient()
        const { data } = await supabase.from('profiles').select('id, full_name, email').in('id', extra)
        setExtraProfiles(data || [])
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Failed to load extra profiles', err)
      }
    })()
  }, [meeting, segueNotes, headlines])
  const [addingEmail, setAddingEmail] = useState('')
  const [addingState, setAddingState] = useState<'idle' | 'loading' | 'error' | 'done'>('idle')
  const measurables = scorecardItems.filter((s: ScorecardItem) => s.item_type === 'measurable')
  const rocks = scorecardItems.filter((s: ScorecardItem) => s.item_type === 'rock')
  const carriedTodos = todos.filter((t: Todo) => !t.is_new)
  const newTodos = todos.filter((t: Todo) => t.is_new)

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
        <div className="max-w-3xl mx-auto flex items-center gap-6 text-sm">
          {/* manager */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full flex items-center justify-center text-white font-semibold text-sm" style={{ backgroundColor: colorFor(meeting.manager?.id || meeting.manager?.full_name) }}>
              {initials(meeting.manager?.full_name)}
            </div>
            <div>
              <div className="text-xs text-gray uppercase">Manager</div>
              <div className="font-semibold">{meeting.manager?.full_name || 'Manager'}</div>
            </div>
          </div>

          {/* report */}
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full flex items-center justify-center text-white font-semibold text-sm" style={{ backgroundColor: colorFor(meeting.report?.id || meeting.report?.full_name) }}>
              {initials(meeting.report?.full_name)}
            </div>
            <div>
              <div className="text-xs text-gray uppercase">Report</div>
              <div className="font-semibold">{meeting.report?.full_name || 'TBD'}</div>
            </div>
          </div>

          {/* extra participants */}
          {extraProfiles.map(p => (
            <div key={p.id} className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full flex items-center justify-center text-white font-semibold text-sm" style={{ backgroundColor: colorFor(p.id || p.full_name) }}>{initials(p.full_name)}</div>
              <div>
                <div className="text-xs text-gray uppercase">Participant</div>
                <div className="font-semibold">{p.full_name || p.email}</div>
              </div>
            </div>
          ))}

          <div className="ml-auto flex items-center gap-2">
            <input value={addingEmail} onChange={e => setAddingEmail(e.target.value)} placeholder="Add participant email" className="border border-light-gray rounded px-3 py-1 text-sm" />
            <button onClick={async () => {
              if (!addingEmail) return
              setAddingState('loading')
              try {
                const { createClient } = await import('@/lib/supabase')
                const supabase = createClient()
                const { data: profile, error } = await supabase.from('profiles').select('id, full_name, email').eq('email', addingEmail).maybeSingle()
                if (error) throw error
                if (!profile) {
                  setAddingState('error')
                  return
                }
                // create placeholder segue and headline rows for this participant
                await supabase.from('segue_notes').insert({ meeting_id: meeting.id, user_id: profile.id, personal_win: '', professional_win: '' })
                await supabase.from('headlines').insert({ meeting_id: meeting.id, user_id: profile.id, content: '' })
                setAddingEmail('')
                setAddingState('done')
                // refresh local data
                await refetch()
                // fetch extra profiles again below by effect
              } catch (err) {
                // eslint-disable-next-line no-console
                console.error('Add participant failed', err)
                setAddingState('error')
              }
            }} className={`py-1 px-3 rounded bg-steel-blue text-white text-sm ${addingState==='loading' ? 'opacity-70' : ''}`}>Add</button>
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
        {/* Weekly Commitments */}
        <div className="bg-white rounded-xl border border-light-gray p-6">
          <h2 className="text-lg font-bold text-deep-purple mb-2">Weekly Commitments</h2>
          <p className="text-sm text-gray mb-4">Float tasks during the week and notify assignees via email or Slack.</p>
          <WeeklyCommitments meetingId={id} participants={[meeting.manager, meeting.report, ...extraProfiles]} />
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
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Manager column */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full flex items-center justify-center text-white font-semibold text-xs" style={{ backgroundColor: colorFor(meeting.manager?.id || meeting.manager?.full_name) }}>{initials(meeting.manager?.full_name)}</div>
                            <label className="text-[11px] font-bold uppercase tracking-wide text-medium-purple">{meeting.manager?.full_name || 'Manager'}</label>
                          </div>
                          <span className="text-xs text-gray">Manager</span>
                        </div>
                        {managerSegue ? (
                          <>
                            {amManager ? (
                              <>
                                <textarea
                                  defaultValue={managerSegue.personal_win || ''}
                                  placeholder="Personal win..."
                                  onBlur={e => updateSegueNote(managerSegue.id, { personal_win: e.target.value })}
                                  className="w-full border border-light-gray rounded-lg px-3 py-2 text-sm resize-none focus:border-steel-blue focus:outline-none mb-2"
                                  rows={2}
                                />
                                <textarea
                                  defaultValue={managerSegue.professional_win || ''}
                                  placeholder="Professional win..."
                                  onBlur={e => updateSegueNote(managerSegue.id, { professional_win: e.target.value })}
                                  className="w-full border border-light-gray rounded-lg px-3 py-2 text-sm resize-none focus:border-steel-blue focus:outline-none"
                                  rows={2}
                                />
                              </>
                            ) : (
                              <>
                                <p className="text-sm">{managerSegue.personal_win || <span className="text-light-gray italic">Not yet filled in</span>}</p>
                                <p className="text-sm mt-1">{managerSegue.professional_win || <span className="text-light-gray italic">Not yet filled in</span>}</p>
                              </>
                            )}
                          </>
                        ) : (
                          amManager ? (
                            <>
                              <textarea placeholder="Personal win..." className="w-full border border-light-gray rounded-lg px-3 py-2 text-sm resize-none focus:border-steel-blue focus:outline-none mb-2" rows={2} />
                              <textarea placeholder="Professional win..." className="w-full border border-light-gray rounded-lg px-3 py-2 text-sm resize-none focus:border-steel-blue focus:outline-none" rows={2} />
                            </>
                          ) : (
                            <p className="text-sm text-light-gray italic">Not yet filled in</p>
                          )
                        )}
                      </div>

                      {/* Report column */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full flex items-center justify-center text-white font-semibold text-xs" style={{ backgroundColor: colorFor(meeting.report?.id || meeting.report?.full_name) }}>{initials(meeting.report?.full_name)}</div>
                            <label className="text-[11px] font-bold uppercase tracking-wide text-medium-purple">{meeting.report?.full_name || 'Report'}</label>
                          </div>
                          <span className="text-xs text-gray">Report</span>
                        </div>
                        {reportSegue ? (
                          <>
                            {amReport ? (
                              <>
                                <textarea
                                  defaultValue={reportSegue.personal_win || ''}
                                  placeholder="Personal win..."
                                  onBlur={e => updateSegueNote(reportSegue.id, { personal_win: e.target.value })}
                                  className="w-full border border-light-gray rounded-lg px-3 py-2 text-sm resize-none focus:border-steel-blue focus:outline-none mb-2"
                                  rows={2}
                                />
                                <textarea
                                  defaultValue={reportSegue.professional_win || ''}
                                  placeholder="Professional win..."
                                  onBlur={e => updateSegueNote(reportSegue.id, { professional_win: e.target.value })}
                                  className="w-full border border-light-gray rounded-lg px-3 py-2 text-sm resize-none focus:border-steel-blue focus:outline-none"
                                  rows={2}
                                />
                              </>
                            ) : (
                              <>
                                <p className="text-sm">{reportSegue.personal_win || <span className="text-light-gray italic">Not yet filled in</span>}</p>
                                <p className="text-sm mt-1">{reportSegue.professional_win || <span className="text-light-gray italic">Not yet filled in</span>}</p>
                              </>
                            )}
                          </>
                        ) : (
                          amReport ? (
                            <>
                              <textarea placeholder="Personal win..." className="w-full border border-light-gray rounded-lg px-3 py-2 text-sm resize-none focus:border-steel-blue focus:outline-none mb-2" rows={2} />
                              <textarea placeholder="Professional win..." className="w-full border border-light-gray rounded-lg px-3 py-2 text-sm resize-none focus:border-steel-blue focus:outline-none" rows={2} />
                            </>
                          ) : (
                            <p className="text-sm text-light-gray italic">Not yet filled in</p>
                          )
                        )}
                      </div>
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
                    <div>
                      <label className="text-[11px] font-bold uppercase tracking-wide text-medium-purple mb-2 block">Quarterly Rocks</label>
                      <ScorecardList items={rocks} meetingId={id} type="rock" onUpdate={refetch} />
                    </div>
                  </div>
                )}

                {/* ── Headlines ── */}
                {section.key === 'headlines' && (
                  <div className="space-y-3">
                    <p className="text-sm text-gray font-condensed leading-relaxed">
                      Employee, customer, or operational news worth flagging — good or bad.
                    </p>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      {/* Manager headlines */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full flex items-center justify-center text-white font-semibold text-xs" style={{ backgroundColor: colorFor(meeting.manager?.id || meeting.manager?.full_name) }}>{initials(meeting.manager?.full_name)}</div>
                            <label className="text-[11px] font-bold uppercase tracking-wide text-medium-purple">{meeting.manager?.full_name || 'Manager'}</label>
                          </div>
                          <span className="text-xs text-gray">Manager</span>
                        </div>
                        {managerHeadline ? (
                          amManager ? (
                            <textarea
                              defaultValue={managerHeadline.content || ''}
                              placeholder="News and updates..."
                              onBlur={e => updateHeadline(managerHeadline.id, e.target.value)}
                              className="w-full border border-light-gray rounded-lg px-3 py-2 text-sm resize-none focus:border-steel-blue focus:outline-none"
                              rows={3}
                            />
                          ) : (
                            <div className="bg-bg rounded-lg p-3"><p className="text-sm whitespace-pre-wrap">{managerHeadline.content || <span className="text-light-gray italic">Not yet filled in</span>}</p></div>
                          )
                        ) : (
                          amManager ? (
                            <textarea placeholder="News and updates..." className="w-full border border-light-gray rounded-lg px-3 py-2 text-sm resize-none focus:border-steel-blue focus:outline-none" rows={3} />
                          ) : (
                            <p className="text-sm text-light-gray italic">Not yet filled in</p>
                          )}
                      </div>

                      {/* Report headlines */}
                      <div>
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <div className="w-7 h-7 rounded-full flex items-center justify-center text-white font-semibold text-xs" style={{ backgroundColor: colorFor(meeting.report?.id || meeting.report?.full_name) }}>{initials(meeting.report?.full_name)}</div>
                            <label className="text-[11px] font-bold uppercase tracking-wide text-medium-purple">{meeting.report?.full_name || 'Report'}</label>
                          </div>
                          <span className="text-xs text-gray">Report</span>
                        </div>
                        {reportHeadline ? (
                          amReport ? (
                            <textarea
                              defaultValue={reportHeadline.content || ''}
                              placeholder="News and updates..."
                              onBlur={e => updateHeadline(reportHeadline.id, e.target.value)}
                              className="w-full border border-light-gray rounded-lg px-3 py-2 text-sm resize-none focus:border-steel-blue focus:outline-none"
                              rows={3}
                            />
                          ) : (
                            <div className="bg-bg rounded-lg p-3"><p className="text-sm whitespace-pre-wrap">{reportHeadline.content || <span className="text-light-gray italic">Not yet filled in</span>}</p></div>
                          )
                        ) : (
                          amReport ? (
                            <textarea placeholder="News and updates..." className="w-full border border-light-gray rounded-lg px-3 py-2 text-sm resize-none focus:border-steel-blue focus:outline-none" rows={3} />
                          ) : (
                            <p className="text-sm text-light-gray italic">Not yet filled in</p>
                          )}
                      </div>
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

function WeeklyCommitments({ meetingId, participants }: { meetingId: string, participants: any[] }) {
  const [items, setItems] = useState<any[]>([])
  const [title, setTitle] = useState('')
  const [assignee, setAssignee] = useState(participants[0]?.id || '')
  const [due, setDue] = useState('')
  const [notifyEmail, setNotifyEmail] = useState(true)
  const [notifySlack, setNotifySlack] = useState(false)

  const fetchItems = async () => {
    const res = await fetch(`/api/commitments?meeting_id=${meetingId}`)
    const j = await res.json()
    setItems(j.data || [])
  }

  useEffect(() => { fetchItems() }, [])

  const create = async () => {
    if (!title || !assignee) return
    const body = { meeting_id: meetingId, creator_id: participants[0]?.id || '', assignee_id: assignee, title, description: '', due_date: due || null, notify_email: notifyEmail, notify_slack: notifySlack }
    await fetch('/api/commitments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    setTitle('')
    setDue('')
    fetchItems()
  }

  return (
    <div>
      <div className="space-y-3 mb-4">
        {items.map(it => (
          <div key={it.id} className="flex items-center justify-between p-3 border rounded">
            <div>
              <div className="font-semibold">{it.title}</div>
              <div className="text-xs text-gray">Due: {it.due_date || '—'}</div>
            </div>
            <div className="text-sm text-gray">{it.assignee_id}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
        <input className="col-span-2 border px-3 py-2 rounded" placeholder="Commitment title" value={title} onChange={e => setTitle(e.target.value)} />
        <input type="date" className="border px-3 py-2 rounded" value={due} onChange={e => setDue(e.target.value)} />
        <select className="col-span-2 border px-3 py-2 rounded" value={assignee} onChange={e => setAssignee(e.target.value)}>
          {participants.map(p => <option key={p.id} value={p.id}>{p.full_name || p.email}</option>)}
        </select>
        <div className="flex items-center gap-2">
          <label className="text-sm"><input type="checkbox" checked={notifyEmail} onChange={e => setNotifyEmail(e.target.checked)} /> Email</label>
          <label className="text-sm"><input type="checkbox" checked={notifySlack} onChange={e => setNotifySlack(e.target.checked)} /> Slack</label>
        </div>
        <div className="col-span-3 flex justify-end">
          <button onClick={create} className="bg-steel-blue text-white px-4 py-2 rounded">Add Commitment</button>
        </div>
      </div>
    </div>
  )
}
