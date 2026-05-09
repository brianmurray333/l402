# l402
L402 app store

## Local setup
1. Install dependencies: `npm install`
2. Create a `.env` file (see env vars below).
3. Start the server: `npm start`
4. Open `http://localhost:3000`

## Env vars
Set these in `.env`:
- `RESEND_API_KEY`: Your Resend API key.
- `RESEND_FROM`: Verified sender (ex: `onboarding@resend.dev` for testing).
- `RESEND_TO`: Where to send submission alerts (default `brianmurray03@gmail.com`).
- `PORT`: Optional, defaults to `3000`.
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`: Required in production when Lightning rewards are enabled, so daily and IP limits apply across serverless instances. Apply `supabase-migration.sql` in the Supabase SQL editor (includes `api_submission_rate_events` for IP throttling).
- Optional `SUPABASE_ACCESS_TOKEN` (personal access token, `sbp_…`): lets you run `node scripts/run-mgmt-sql.mjs` to apply `scripts/sql/apply-rate-events.sql` via the Management API instead of the SQL editor.
