Local development helpers

Start dev server (polling enabled):

    npm run dev

Stop any running dev server on port 3000:

    npm run stop

If you get Watchpack EMFILE errors despite polling, either:
- increase macOS file limits (requires reboot and admin steps), or
- keep using polling (less efficient but stable).

Smoke test locally (hits deployed URL by default):

    npm run smoke

To seed example data in Supabase (manual steps):
1. Create a test user via Supabase Auth (sign up or invite).
2. Copy the user's UUID and use `supabase-seed.sql` in the SQL editor to insert a profile and a meeting.
