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
