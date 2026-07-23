"""
Send queued mail for BlueHorizon Portal (runs in GitHub Actions on push).

The portal Worker writes jobs to data/mail/outbox/<id>.json:
    {"to": "...", "subject": "...", "body": "..."}
This sends each via the club Gmail (MAIL_USERNAME / MAIL_PASSWORD) and deletes
the file so it isn't sent twice. Used for password-reset emails, etc.
"""

import json
import os
import smtplib
import sys
from email.mime.text import MIMEText
from pathlib import Path

OUTBOX = Path("data/mail/outbox")


def main():
    user = os.environ.get("MAIL_USERNAME")
    pwd = os.environ.get("MAIL_PASSWORD")
    server = os.environ.get("SMTP_SERVER", "smtp.gmail.com")
    if not user or not pwd:
        print("MAIL_USERNAME / MAIL_PASSWORD not set — cannot send.")
        return
    if not OUTBOX.exists():
        print("no outbox")
        return

    jobs = sorted(OUTBOX.glob("*.json"))
    if not jobs:
        print("nothing queued")
        return

    with smtplib.SMTP_SSL(server, 465) as smtp:
        smtp.login(user, pwd)
        for job_file in jobs:
            try:
                job = json.loads(job_file.read_text())
                msg = MIMEText(job["body"])
                msg["Subject"] = job.get("subject", "BlueHorizon")
                msg["From"] = user
                msg["To"] = job["to"]
                smtp.send_message(msg)
                print(f"sent to {job['to']}: {msg['Subject']}")
            except Exception as e:
                print(f"FAILED {job_file.name}: {e}", file=sys.stderr)
            finally:
                # delete regardless so a bad job doesn't loop forever
                try:
                    job_file.unlink()
                except OSError:
                    pass


if __name__ == "__main__":
    main()
