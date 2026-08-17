export interface Profile {
  id: string
  full_name: string
  email: string
  role: 'manager' | 'report'
}

export interface Meeting {
  id: string
  meeting_date: string
  manager_id: string
  report_id: string | null
  status: 'prep' | 'active' | 'completed'
  rating: number | null
  created_at: string
  updated_at: string
  // Joined fields
  manager?: Profile
  report?: Profile
}

export type ParticipantRole = 'manager' | 'report' | 'participant'

export interface MeetingParticipant {
  id: string
  meeting_id: string
  user_id: string
  role: ParticipantRole
  // Joined field
  profile?: Profile
}

export interface SegueNote {
  id: string
  meeting_id: string
  user_id: string
  personal_win: string
  professional_win: string
}

export interface ScorecardItem {
  id: string
  meeting_id: string
  item_type: 'measurable' | 'rock'
  name: string
  on_track: boolean
  sort_order: number
}

export interface Headline {
  id: string
  meeting_id: string
  user_id: string
  content: string
}

export interface Issue {
  id: string
  meeting_id: string
  description: string
  priority: 'H' | 'M' | 'L'
  resolution: string
  resolved: boolean
  sort_order: number
}

export interface Todo {
  id: string
  meeting_id: string
  text: string
  owner: string
  done: boolean
  carried_from_id: string | null
  is_new: boolean
  sort_order: number
}

export interface Commitment {
  id: string
  meeting_id: string
  creator_id: string
  assignee_id: string
  title: string
  description: string
  due_date: string | null
  status: 'open' | 'done'
  notify_email: boolean
  notify_slack: boolean
  notified: boolean
  created_at: string
}

export interface ExtractedItem {
  id: string
  meeting_id: string
  source: 'upload' | 'granola'
  source_ref: string | null
  extracted_by: string | null
  target: 'todo' | 'commitment' | 'issue'
  title: string
  owner_id: string | null
  due_date: string | null
  evidence: string
  confidence: 'high' | 'medium' | 'low'
  duplicate_of_kind: 'todo' | 'commitment' | null
  duplicate_of_id: string | null
  status: 'pending' | 'accepted' | 'rejected'
  reviewed_by: string | null
  reviewed_at: string | null
  accepted_kind: 'todo' | 'commitment' | 'issue' | null
  accepted_id: string | null
  created_at: string
}

export interface SectionTimer {
  id: string
  meeting_id: string
  section_key: string
  elapsed_seconds: number
  completed: boolean
}

export const SECTIONS = [
  { key: 'segue', title: 'Segue', label: '3 MINUTES', allotted: 180 },
  { key: 'scorecard', title: 'Scorecard & Rock Pulse', label: '5 MINUTES', allotted: 300 },
  { key: 'headlines', title: 'Headlines', label: '3 MINUTES', allotted: 180 },
  { key: 'ids', title: 'Issues — Identify, Discuss, Solve', label: '14 MINUTES', allotted: 840 },
  { key: 'todos', title: 'To-Dos & Wrap', label: '5 MINUTES', allotted: 300 },
] as const
