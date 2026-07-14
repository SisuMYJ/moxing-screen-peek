# moxing-screen-peek

A tiny iPhone screen-peek relay for 墨行小雷达.

## What it does

- `POST /api/peek?key=<PEEK_TOKEN>`: iPhone uploads a screenshot.
- `GET /api/trigger?key=<VIEW_TOKEN>`: server sends the trigger email.
- `GET /api/latest.png?key=<VIEW_TOKEN>`: returns the latest screenshot.
- `GET /api/see?key=<VIEW_TOKEN>`: if the latest screenshot is fresh, returns it; otherwise sends the trigger email and waits for a new screenshot.

## Railway environment variables

Set these in Railway Variables. Do not put secrets in GitHub.

```text
PEEK_TOKEN=make-a-long-random-token
VIEW_TOKEN=make-another-long-random-token
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=your-gmail-address@gmail.com
SMTP_PASS=your-16-character-google-app-password
TRIGGER_TO_EMAIL=your-icloud-address@icloud.com
TRIGGER_SUBJECT=MOXING_PEEK
```

Optional:

```text
FRESH_MS=60000
WAIT_MS=45000
MAX_KEEP=10
```

## iPhone Shortcut upload URL

Use this URL in Shortcuts after Railway deployment:

```text
https://<your-railway-domain>/api/peek?key=<PEEK_TOKEN>
```

Use POST and set the request body to File = Screenshot.
