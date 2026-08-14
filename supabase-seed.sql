-- supabase-seed.sql
-- Safe guide to seed sample data. This file intentionally does not
-- perform inserts that would violate foreign key constraints against
-- auth.users. Follow the steps below in the Supabase SQL editor.

-- 1) Create a test user via Supabase Auth (Auth -> Users -> Invite user or Sign Up via the app)
-- 2) Take the user's UUID from Auth and run the following (replace <USER_UUID>):

-- INSERT INTO public.profiles (id, full_name, email)
-- VALUES ('<USER_UUID>', 'Test User', 'test@example.com');

-- 3) Create a sample meeting for that profile (replace <USER_UUID> with id from step 2):
-- INSERT INTO public.meetings (manager_id, report_id, meeting_date, status)
-- VALUES ('<USER_UUID>', NULL, current_date, 'prep');

-- 4) Optionally seed other tables referencing the meeting id returned above.

-- This file is intentionally a template so seeding is performed safely in the
-- Supabase SQL editor by the project owner (avoids accidental FK errors).
