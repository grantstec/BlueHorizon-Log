# Cloudflare Portal Server — setup (~10 minutes, free tier)

This Worker gives the portal real **accounts with roles**, keeps the GitHub token
**server-side** (members never see it), and hosts the **proxy** that makes PO link
scanning and 889 checks work from the campus network.

## Steps (dashboard method — no command line)

1. **Create account** at https://dash.cloudflare.com (free plan is plenty).

2. **Create the database**: Storage & Databases → D1 → Create → name it `bluehorizon`.
   Open it → Console → paste the contents of `schema.sql` → Execute.

3. **Create the Worker**: Workers & Pages → Create → Worker → name `bluehorizon-portal`
   → Deploy the hello-world → **Edit code** → replace everything with `worker.js` → Deploy.

4. **Bind + configure** (Worker → Settings):
   - Bindings → Add → **D1 database** → variable name `DB` → select `bluehorizon`.
   - Variables & secrets → add **variables**:
     - `GH_REPO` = `grantstec/BlueHorizon-Log`
     - `ALLOWED_ORIGIN` = `https://grantstec.github.io`
   - Add **secrets**:
     - `GH_TOKEN` = a fine-grained PAT with **Contents: Read & write** on the repo only
     - `SESSION_SECRET` = any long random string (password-manager-generate 64 chars)

5. **Point the portal at it**: open the portal → Settings → *Portal server URL* =
   `https://bluehorizon-portal.<your-subdomain>.workers.dev` → Save.

6. **Claim admin**: the **first account created becomes admin** — sign up immediately
   after deploying. Everyone after you lands as *pending* until you approve them in
   More → Team Roster.

## What changes once it's live
- Members sign up with username/password; you approve; nobody handles GitHub tokens.
- Roles: `pending` (read-only) → `member` (can post) → `lead` → `admin` (approvals, roster, hero video).
- PO autofill + 889 checks route through `/api/fetch` and `/api/889` on your own
  domain — immune to campus proxy blocking.
- Old invite links / direct-token mode still work as a fallback if the Worker is down.

## Free-tier limits (fine for a club)
100,000 requests/day, D1 5 GB. Photos/files still live in GitHub, so Worker traffic is light.
