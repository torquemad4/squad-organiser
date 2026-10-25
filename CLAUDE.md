# Squad Organiser

See README.md for what this app does, how it deploys and where its data lives.

## Karl's app SOP (from the App Register in Notion, 25 Oct 2026)
- This repo = one Claude Code project, same name. Prefer cloud sessions.
- Host on torquemada.uk (Team England apps: englandbb.co.uk). Keep the hostname, D1 name/id and Access scope in this README.
- Cloudflare Access, Karl only, unless this README records a waiver.
- All app state lives on Cloudflare (D1/R2/KV). Every piece of state must be readable/writable headlessly with plain SQL; document the schema in the README.
- HANDOVERS: when anything must reach Karl's Cowork side (skill changes, routing changes, decisions needed, what changed), create a row in the Notion database "📨 Code Messenger" (collection://66404db8-241d-4f62-a32f-6800d00079ad): Title, App = repo name, Type = Handover | Needs Karl | FYI, Body, Status = New, Session = this session's URL. Do not rely on a chat handover being carried by hand.
- CLOSING: if this session's work finishes a Notion task (Personal Tasks or Review Queue), flip that row to Done yourself, with a one-line note and this session's URL. A task claimed as In progress must never be left for the other side to close.
- Commit to the repo in the same session that does the work.
