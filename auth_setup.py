"""
Run this ONCE locally to generate token.json for Google Calendar access.

Requirements:
  - credentials.json must be present (download from Google Cloud Console)
  - pip install google-auth-oauthlib

Usage:
  python auth_setup.py
"""
import json
from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/calendar.events"]

flow = InstalledAppFlow.from_client_secrets_file("credentials.json", SCOPES)
creds = flow.run_local_server(port=0)

with open("token.json", "w") as f:
    f.write(creds.to_json())

print("✅ token.json written.")
print()
print("For Zeabur deployment, set GOOGLE_TOKEN_JSON to the value below:")
print()
print(json.dumps(json.loads(creds.to_json())))
