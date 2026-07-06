# BlueHorizon Log

A minimal, mobile-first documentation app for BlueHorizon Rocketry. Members open it on their phone, snap photos, write two sentences, and post. Everything is stored in a GitHub repo — free, permanent, and it survives member turnover.

**Views:** Home (team goals, tasks with deadlines and assignees, latest activity) · Feed (all entries, filter by project/journal/meeting) · Photos (every photo ever posted) · Projects · Meeting Notes · Purchase Orders (import an Excel PO, check off items as they arrive) · Team Roster. Global search covers everything. Entries can be edited/deleted and can carry file attachments (Excel files open in an inline viewer).

## One-time setup (team lead — ~10 minutes)

### 1. Deploy the app
1. Create a GitHub repo (e.g. `BlueHorizon-Log`) and push the contents of this folder to it.
2. Repo → Settings → Pages → Source: **Deploy from branch** → `main` / root.
3. Your app is live at `https://<org-or-user>.github.io/BlueHorizon-Log/`.

The same repo also stores the data — no second repo needed. Make it **public** so everyone can read without a token (posting still requires one).

### 2. Create the posting token
1. GitHub → Settings → Developer settings → **Fine-grained personal access tokens** → Generate new token.
2. Repository access: only the log repo. Permissions: **Contents → Read and write**. Expiration: 1 year (set a calendar reminder).
3. Share the token with members in your team chat. One shared token is the simplest option for a club; entries are still attributed by the name each member sets in the app.

> Prefer per-member tokens? Any member with write access to the repo can generate their own the same way. Commits are then attributed to their GitHub account too.

### 3. First launch
Open the app → Settings opens automatically:
- **Your name** — shown on entries
- **GitHub repo** — `owner/repo` (e.g. `grantstec/BlueHorizon-Log`)
- **Branch** — `main`
- **Token** — paste it
- Hit **Test connection**, then **Save**.

Default projects (Engine, Flight Computer, GSE, Sim & Controls, Solids, Structures, Team) appear automatically; add more with **+ Add project**. The `data/` folder in the repo is created automatically on first post.

## Member onboarding (~1 minute)
Send new members: the app URL, the token, and "set your name in Settings." On a phone, use **Add to Home Screen** (Share menu on iOS, install prompt on Android) — it then behaves like a native app, and "Add photos" opens the camera.

## Email reminders (optional, ~5 minutes)
A GitHub Action (`.github/workflows/reminders.yml`) runs daily and emails members about tasks due within 3 days / overdue, plus a Friday journal nudge. **Emails are never stored in the public repo** — they live in a repo secret.

Setup (repo → Settings → Secrets and variables → Actions → New repository secret):

1. `MAIL_USERNAME` — a Gmail address for the club (e.g. bluehorizon.rocketry@gmail.com)
2. `MAIL_PASSWORD` — a Gmail **App Password** (Google Account → Security → 2-Step Verification → App passwords)
3. `ROSTER_EMAILS` — JSON mapping roster ids to emails: `{"grant-s": "grant@example.com", "jane-d": "jane@example.com"}`. Roster ids are the `id` fields in `data/roster.json` (lowercase-hyphenated names).

Test it: repo → Actions → "Email reminders" → Run workflow. Optional variables: `SMTP_SERVER` (default smtp.gmail.com), `APP_URL`.

## How data is stored
```
data/
  projects.json        # project list
  roster.json          # member names (ids used for task assignment — NO emails)
  team.json            # goals + tasks (assignees, deadlines, status)
  pos.json             # purchase orders (line items + arrived status)
  index.json           # all entry metadata (feed loads this — one request)
  entries/<id>.md      # each entry as durable markdown with frontmatter
  photos/<id>/<n>.jpg  # photos, auto-compressed to ≤1600px JPEG
  files/<id>/<name>    # attachments (Excel, PDF, CAD, ...) and original PO files
```
Photos are compressed on the phone before upload (~200–400 KB each), so repo size stays manageable for years. Because entries are plain markdown + JPEG in git, the archive is readable forever — even without this app — and can later be rendered into a public site.

## Handoff notes (for future web teams)
- Plain HTML/CSS/JS, zero build step, zero dependencies. Edit `app.js`, push, done.
- `app.js` top comment documents the data layout and GitHub API usage.
- Token is stored only in each device's localStorage.
- If the index ever gets corrupted, it can be rebuilt from `data/entries/*.md`.
