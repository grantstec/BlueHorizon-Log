"""
BlueHorizon Log — email reminders (runs daily via GitHub Actions).

Sends:
  * Task reminders to assignees when a task is due within 3 days or overdue.
  * A weekly journal nudge to everyone on Fridays.

Configuration (GitHub repo -> Settings -> Secrets and variables -> Actions):
  Secrets:
    MAIL_USERNAME   SMTP login, e.g. bluehorizon.rocketry@gmail.com
    MAIL_PASSWORD   SMTP password (for Gmail: an App Password, not your real one)
    ROSTER_EMAILS   JSON mapping roster id -> email, e.g.
                    {"grant-s": "grant@example.com", "jane-d": "jane@example.com"}
                    (roster ids are the "id" fields in data/roster.json)
  Variables (optional):
    SMTP_SERVER     default smtp.gmail.com
    APP_URL         link included in emails

Emails are intentionally short — the goal is a tap, not a chore.
"""

import json
import os
import smtplib
import sys
from datetime import date, datetime, timedelta
from email.mime.text import MIMEText


def load_json(path, fallback):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback


def main():
    user = os.environ.get("MAIL_USERNAME")
    pwd = os.environ.get("MAIL_PASSWORD")
    emails = json.loads(os.environ.get("ROSTER_EMAILS") or "{}")
    server = os.environ.get("SMTP_SERVER", "smtp.gmail.com")
    app_url = os.environ.get("APP_URL", "")

    if not user or not pwd:
        print("MAIL_USERNAME / MAIL_PASSWORD secrets not set — skipping.")
        return
    if not emails:
        print("ROSTER_EMAILS secret empty — nobody to email.")
        return

    team = load_json("data/team.json", {"goals": [], "tasks": []})
    roster = {m["id"]: m["name"] for m in load_json("data/roster.json", [])}

    today = date.today()
    soon = today + timedelta(days=3)
    messages = []  # (to_email, subject, body)

    # ---- task reminders ----
    per_person = {}  # rid -> [lines]
    for t in team.get("tasks", []):
        if t.get("status") == "done" or not t.get("due"):
            continue
        try:
            due = datetime.strptime(t["due"], "%Y-%m-%d").date()
        except ValueError:
            continue
        if due > soon:
            continue
        tag = "OVERDUE" if due < today else ("due TODAY" if due == today else f"due {due:%a %b %d}")
        line = f"  * [{tag}] {t['title']}"
        for rid in t.get("assignees", []):
            per_person.setdefault(rid, []).append(line)

    for rid, lines in per_person.items():
        email = emails.get(rid)
        if not email:
            print(f"No email configured for roster id '{rid}' — skipping.")
            continue
        name = roster.get(rid, rid).split(" ")[0]
        body = (
            f"Hey {name},\n\nHeads up on your BlueHorizon tasks:\n\n"
            + "\n".join(lines)
            + f"\n\nOpen the app to update them: {app_url}\n\n— BlueHorizon Log (automated)"
        )
        messages.append((email, "BlueHorizon: task deadlines", body))

    # ---- Friday journal nudge ----
    if today.weekday() == 4:  # Friday
        for rid, email in emails.items():
            name = roster.get(rid, rid).split(" ")[0]
            body = (
                f"Hey {name},\n\nQuick Friday nudge: post your weekly journal — even two sentences "
                f"about what you worked on helps the next person pick up where you left off.\n\n"
                f"{app_url}\n\n— BlueHorizon Log (automated)"
            )
            messages.append((email, "BlueHorizon: weekly journal reminder", body))

    if not messages:
        print("Nothing to send today.")
        return

    with smtplib.SMTP_SSL(server, 465) as smtp:
        smtp.login(user, pwd)
        for to, subject, body in messages:
            msg = MIMEText(body)
            msg["Subject"] = subject
            msg["From"] = user
            msg["To"] = to
            try:
                smtp.send_message(msg)
                print(f"Sent '{subject}' to {to}")
            except Exception as e:  # keep going if one address bounces
                print(f"FAILED {to}: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
