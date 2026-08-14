#!/usr/bin/env node
/*
  Seed demo users and a meeting for quick testing.
  Usage (run locally):

    SUPABASE_URL=https://your.supabase.co SUPABASE_SERVICE_ROLE_KEY=your_service_role_key node ./scripts/seed_demo.js

  This script requires a Supabase service_role key — DO NOT commit that key.
*/

import pkg from '@supabase/supabase-js'
const { createClient } = pkg

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY environment variables.')
  console.error('Run: SUPABASE_URL=https://... SUPABASE_SERVICE_ROLE_KEY=... node ./scripts/seed_demo.js')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

async function ensureUser(email, full_name) {
  try {
    // Try to create the auth user via admin API
    const res = await supabase.auth.admin.createUser({
      email,
      password: 'TempPass#1234',
      user_metadata: { full_name },
      email_confirm: true
    })
    if (res.user) {
      console.log('Created auth user:', email, res.user.id)
      return res.user
    }
    // If API returned error, fallthrough
    if (res.error) throw res.error
  } catch (err) {
    // If user exists, try to find them
    console.log(`Could not create user ${email}:`, err.message || err)
    const list = await supabase.auth.admin.listUsers()
    const found = list.users.find(u => u.email && u.email.toLowerCase() === email.toLowerCase())
    if (found) {
      console.log('Found existing auth user for', email)
      return found
    }
    throw err
  }
}

async function upsertProfile(user) {
  const up = await supabase.from('profiles').upsert({ id: user.id, full_name: user.user_metadata?.full_name || user.full_name || null, email: user.email }, { onConflict: 'id' })
  if (up.error) throw up.error
  console.log('Upserted profile for', user.email)
}

async function createMeeting(managerId, reportId) {
  const { data, error } = await supabase.from('meetings').insert({ manager_id: managerId, report_id: reportId || null, meeting_date: new Date().toISOString().split('T')[0], status: 'prep' }).select().single()
  if (error) throw error
  console.log('Created meeting', data.id)
  return data
}

async function main() {
  try {
    const emails = [
      { email: 'sam@datavations.com', name: 'Sam Datavations' },
      { email: 'ash@datavations.com', name: 'Ash Datavations' }
    ]

    const users = []
    for (const e of emails) {
      const u = await ensureUser(e.email, e.name)
      users.push(u)
      await upsertProfile(u)
    }

    // Create a meeting where Sam is manager and Ash is report
    const sam = users.find(u => u.email.toLowerCase() === 'sam@datavations.com')
    const ash = users.find(u => u.email.toLowerCase() === 'ash@datavations.com')
    const meeting = await createMeeting(sam.id, ash.id)
    console.log('Demo seeding complete. Meeting URL: /meeting/' + meeting.id)
  } catch (err) {
    console.error('Seeding failed:', err)
    process.exit(2)
  }
}

main()
