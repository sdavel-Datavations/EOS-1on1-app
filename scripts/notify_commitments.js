#!/usr/bin/env node
/*
  Run this periodically (cron, GitHub Actions, or serverless) to notify about due commitments.

  Requires env:
    SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
    SENDGRID_API_KEY (optional, for emails)
    SLACK_WEBHOOK_URL (optional, for slack)
    NOTIFY_DAYS_BEFORE (optional, default 1)
*/

import pkg from '@supabase/supabase-js'
import sgMail from '@sendgrid/mail'

const { createClient } = pkg

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE)
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK_URL
const DAYS = parseInt(process.env.NOTIFY_DAYS_BEFORE || '1', 10)

if (SENDGRID_API_KEY) sgMail.setApiKey(SENDGRID_API_KEY)

async function run() {
  const dueDate = new Date()
  dueDate.setDate(dueDate.getDate() + DAYS)
  const dateStr = dueDate.toISOString().split('T')[0]

  const { data: commitments, error } = await supabase
    .from('weekly_commitments')
    .select('id, title, description, due_date, assignee_id, creator_id, meeting_id, notify_email, notify_slack')
    .eq('status', 'open')
    .eq('notified', false) // without this every run re-notifies the same commitments
    .lte('due_date', dateStr)

  if (error) {
    console.error('Query failed', error)
    process.exit(2)
  }

  for (const c of commitments) {
    // load assignee profile
    const { data: profile } = await supabase.from('profiles').select('email, full_name').eq('id', c.assignee_id).maybeSingle()
    const { data: meeting } = await supabase.from('meetings').select('meeting_date').eq('id', c.meeting_id).maybeSingle()

    if (c.notify_email && SENDGRID_API_KEY && profile?.email) {
      const msg = {
        to: profile.email,
        from: process.env.NOTIFY_EMAIL_FROM || 'noreply@yourdomain.com',
        subject: `Commitment due: ${c.title}`,
        text: `${c.description || ''}\nDue: ${c.due_date}\nMeeting: ${meeting?.meeting_date}`
      }
      try {
        await sgMail.send(msg)
        console.log('Email sent to', profile.email)
      } catch (err) {
        console.error('Email send failed', err)
      }
    }

    if (c.notify_slack && SLACK_WEBHOOK) {
      const payload = { text: `*Commitment due:* ${c.title}\nDue: ${c.due_date}\n${c.description || ''}` }
      try {
        await fetch(SLACK_WEBHOOK, { method: 'POST', body: JSON.stringify(payload), headers: { 'Content-Type': 'application/json' } })
        console.log('Sent slack notification for', c.id)
      } catch (err) {
        console.error('Slack notify failed', err)
      }
    }

    // mark notified
    await supabase.from('weekly_commitments').update({ notified: true }).eq('id', c.id)
  }
}

run().then(() => console.log('Done')).catch(err => { console.error(err); process.exit(3) })
