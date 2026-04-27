---
name: mail-inbox-reader
description: Read exported mailbox files from ~/.openclaw/workspace/mailbox/<account-id>, summarize key emails, and draft replies using those local markdown files.
---

# Mail Inbox Reader

Use this skill when the user asks to read, summarize, search, or reply based on local exported emails.

## Source

Emails are exported by the app to:

- `~/.openclaw/workspace/mailbox/<account-id>/index.md`
- `~/.openclaw/workspace/mailbox/<account-id>/<uid>.md`

## Workflow

1. Open `index.md` first to get the recent mail list.
2. Open only the needed `<uid>.md` files for the current task.
3. Produce:
- concise summaries (sender, date, intent, action items)
- extracted TODO list
- reply draft in Chinese unless user asks another language

## Reply Draft Format

```md
主题: <subject>
收件人: <to>
正文:
<draft body>
```

## Guardrails

- Do not fabricate mail content not present in files.
- If body is missing, state that explicitly and suggest opening that email in app detail to refresh cache, then export again.
