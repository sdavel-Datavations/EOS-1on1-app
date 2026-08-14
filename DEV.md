Local development helpers

Start dev server (polling enabled):

        npm run dev

Stop any running dev server on port 3000:

        npm run stop

If you get Watchpack EMFILE errors despite polling, either:

- Quick mitigation (already set in `package.json`): start dev with polling:
    - `npm run dev` (uses `CHOKIDAR_USEPOLLING=true`)

- Increase OS limits (recommended for large projects):
    - Check current limits:
        - `launchctl limit maxfiles`
        - `sysctl kern.maxfiles kern.maxfilesperproc`
    - Temporarily increase (until reboot):
        - `sudo sysctl -w kern.maxfiles=524288`
        - `sudo sysctl -w kern.maxfilesperproc=524288`
    - Make persistent (requires sudo): create `/Library/LaunchDaemons/limit.maxfiles.plist` and load it with `launchctl`.
        - A helper and plist template is available at `scripts/increase_watch_limit.sh`.

### Kill stray Next processes

- Stop the server listening on port 3000:
    - `npm run stop`
- More aggressive (kills `next dev`):
    - `npm run stop-all`

Smoke test locally (hits deployed URL by default):

        npm run smoke

To seed example data in Supabase (manual steps):
1. Create a test user via Supabase Auth (sign up or invite).
2. Copy the user's UUID and use `supabase-seed.sql` in the SQL editor to insert a profile and a meeting.

Automated seeding (local only, requires service role key)

You can run a local script that creates demo accounts and a meeting using a Supabase service role key (keep this secret). Example:

```bash
SUPABASE_URL=https://<project>.supabase.co SUPABASE_SERVICE_ROLE_KEY=eyJ... node ./scripts/seed_demo.js
```

The script will create two users: `sam@datavations.com` and `ash@datavations.com`, upsert profiles, and create a meeting between them. After running it, sign in with `sam@datavations.com` and password `TempPass#1234` (change password after first login).

WARNING: The service role key has admin privileges — do not share or commit it.
