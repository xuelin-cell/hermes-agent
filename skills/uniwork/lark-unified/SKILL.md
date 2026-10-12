---
name: lark-unified
description: "管理飞书消息、文档、表格、日历、任务和知识库能力."
description_zh: "飞书/Lark 全能套件（消息、文档、表格、日历、任务、Wiki 等 11 个业务域）"
description_en: "Lark/Feishu unified CLI: messaging, docs, sheets, calendar, tasks, wiki & more"
version: "1.0.0"
author: "UniWork"
license: Proprietary
platforms: [linux, macos, windows]
tags: [飞书, 协作, 办公]
allowed-tools: Bash, Read
display_name: "lark-unified"
display_name_en: "lark-unified"
visibility: "public"
---

# Lark Unified

Lark (飞书) is a comprehensive collaboration platform combining messaging, documents, spreadsheets, tables, calendars, and more. This skill provides unified access to the **Lark CLI** (`lark-cli`), a production-grade command-line tool with 200+ commands across 11 integrated business domains, along with 19 AI Agent-optimized skills.

## ⚠️ SETUP RULES — READ BEFORE DOING ANYTHING

**FORBIDDEN — never run these commands under any circumstances:**
- `lark-cli config init --new`
- `lark-cli config init` (interactive)
- `lark-cli config set-default`

These require a TTY, output a broken QR code in WorkBuddy, and must never be used.

**REQUIRED setup procedure — follow exactly:**

```bash
# Step 1: install lark-cli if missing
lark-cli --version 2>/dev/null || npm install -g @larksuite/cli

# Step 2: check if already configured (look for "app_id" in output, NOT exit code)
lark-cli config show 2>&1 | grep -q "app_id" && echo "CONFIG_OK" || echo "NOT_CONFIGURED"
```

If step 2 prints `NOT_CONFIGURED`, run the setup script:

```bash
SETUP=$(find ~/.workbuddy/skills -name lark_setup.py 2>/dev/null | head -1)
python3 "$SETUP"

# Lark (international) users:
python3 "$SETUP" --brand lark

# If browser cannot open automatically:
python3 "$SETUP" --no-browser
```

**IMPORTANT: The setup script is a multi-step device flow.**
- Step 1 (begin): The script requests a device code from Feishu. This call may return HTTP 400 transiently — **this is normal, just retry**.
- Step 2 (browser): The script opens a browser URL for the user to authorize.
- Step 3 (poll): The script polls until the user completes authorization in the browser. The poll API returns `authorization_pending` (as HTTP 400) while waiting — **this is expected, NOT an error**. Keep polling.
- Step 4 (save): Once authorized, the script saves the config.

**If the setup script fails or you ran the begin step manually:**
1. You already have the `device_code` — just keep polling with it until the user confirms in the browser.
2. Do NOT re-run the begin step unnecessarily. Reuse the existing device_code.
3. The `authorization_pending` response during polling is **normal** — it means the user hasn't finished yet. Wait and retry.

## Getting Started

```bash
# Verify setup is complete
lark-cli config view
```

All commands:
```bash
lark-cli <domain> <resource> <method> [flags]
lark-cli <domain> +<shortcut> [flags]  # shortcuts preferred
```

**Default identity**: `--as bot`. Use `--as user` for personal operations.

## Core Capability Domains

Lark has 11 primary business domains. Each has dozens of commands, with high-level shortcuts for common operations:

### ✉️ Instant Messaging (lark-im)
Send/receive messages, search chat history, manage groups, download files, and manage reactions.

**Common shortcuts**: `+messages-send`, `+messages-search`, `+chat-messages-list`, `+chat-create`

**Use when**: Messaging users, retrieving conversations, building chat-based workflows, downloading attachments

→ **For detailed API reference, shortcuts, and permission requirements**: See [references/lark-im.md](references/lark-im.md)

### 📄 Cloud Documents (lark-doc)
Create and edit documents, insert media, manage document permissions, and link to wikis.

**Common shortcuts**: `+documents-create`, `+documents-list`

**Use when**: Creating documents programmatically, building document workflows, embedding content

→ **For full reference**: See [references/lark-doc.md](references/lark-doc.md)

### 💾 Cloud Drive & Files (lark-drive)
Upload/download files, manage file permissions, share links, and add comments on files.

**Common shortcuts**: `+files-upload`, `+files-download`

**Use when**: Managing file storage, automating uploads/downloads, sharing files

→ **For full reference**: See [references/lark-drive.md](references/lark-drive.md)

### 📊 Spreadsheets (lark-sheets)
Read/write/append to spreadsheets, query data, and manage sheet permissions.

**Common shortcuts**: `+spreadsheets-read`, `+spreadsheets-append`, `+spreadsheets-find`

**Use when**: Automating spreadsheet operations, reading/updating sheet data, building data workflows

→ **For full reference**: See [references/lark-sheets.md](references/lark-sheets.md)

### 🗂️ Base & Multi-Dimensional Tables (lark-base)
Query and manage multi-dimensional table records, fields, views, dashboards, and run workflows.

**Common shortcuts**: `+tables-records-list`, `+tables-records-create`, `+fields-list`

**Use when**: Managing relational data, querying tables, automating base operations, triggering workflows

→ **For full reference**: See [references/lark-base.md](references/lark-base.md)

### 📅 Calendar (lark-calendar)
Query events, check availability, suggest meeting times, and manage calendar settings.

**Common shortcuts**: `+calendars-list`, `+events-list`, `+events-search-freebusy`

**Use when**: Checking schedules, coordinating meetings, finding available time slots

→ **For full reference**: See [references/lark-calendar.md](references/lark-calendar.md)

### 📋 Tasks & To-Do (lark-task)
Create tasks, organize into lists, manage reminders, and track subtasks.

**Common shortcuts**: `+tasks-create`, `+tasks-list`, `+task-lists-list`

**Use when**: Creating tasks, building task workflows, managing team task lists

→ **For full reference**: See [references/lark-task.md](references/lark-task.md)

### 📧 Mail (lark-mail)
Compose emails, manage drafts, search messages, reply/forward, and send emails.

**Common shortcuts**: `+messages-send`, `+messages-search`, `+drafts-create`

**Use when**: Building email workflows, automating mail operations, searching email history

→ **For full reference**: See [references/lark-mail.md](references/lark-mail.md)

### 📚 Wiki & Knowledge Spaces (lark-wiki)
Create knowledge spaces, organize pages into hierarchies, and manage wiki permissions.

**Common shortcuts**: `+spaces-create`, `+wiki-pages-create`, `+wiki-pages-list`

**Use when**: Building knowledge bases, organizing documentation, creating wikis

→ **For full reference**: See [references/lark-wiki.md](references/lark-wiki.md)

### 🎥 Video Conference & Meetings (lark-vc)
Search meeting recordings, retrieve meeting notes, and manage VC settings.

**Use when**: Accessing meeting data, retrieving recordings and notes, managing video settings

→ **For full reference**: See [references/lark-vc.md](references/lark-vc.md)

### 👥 Contacts & Directory (lark-contact)
Search users, fetch contact profiles, and query user directory.

**Use when**: Searching for users, building user lookups, retrieving contact information

→ **For full reference**: See [references/lark-contact.md](references/lark-contact.md)

## Core Concepts & Common Patterns

### Identity & Authentication

- **User identity** (`--as user`): Operations run as the authenticated user. Uses `user_access_token`. Permissions depend on the user's own access.
- **Bot identity** (`--as bot`): Operations run as the app's bot. Uses `tenant_access_token`. Permissions depend on the bot's scopes and membership.

Most APIs support both modes, but behavior differs based on the caller's role and access.

### Common Entity IDs

- **User**: `open_id`, `user_id`, `email`
- **Chat**: `chat_id` (oc_xxx)
- **Message**: `message_id` (om_xxx)
- **Thread**: `thread_id`
- **Document**: `document_id`
- **File**: `file_key` or `file_id`
- **Table/Base**: `base_id`, `table_id`
- **Event**: `event_id`

### Working with the CLI

#### Using Shortcuts (Recommended)
Shortcuts are high-level wrappers around common operations. Always use shortcuts when available:
```bash
lark-cli im +messages-send --chat-id oc_xxx --text "Hello"
lark-cli sheets +spreadsheets-read --spreadsheet-id spr_xxx
```

#### Using Raw APIs
For operations without shortcuts, use raw API commands with schema inspection:
```bash
lark-cli schema im.messages.create       # View parameter structure
lark-cli im messages create --data '{...}'  # Call with structured data
```

**Important**: Always run `schema` before calling raw APIs to understand the exact parameter format.

#### Pagination & Filtering
Most list operations support:
- `--limit`: Number of records to return (default varies by API)
- `--offset` / `--page-token`: Pagination cursor
- `--filter`: Server-side filtering (format varies by resource)

#### Output Formatting
By default, commands return JSON. Common options:
- `--table`: Format output as ASCII table
- `--csv`: Export as CSV
- `--yaml`: YAML format
- `--raw`: Unformatted raw output

### Workflows

Lark offers two built-in workflow skills:
- **Meeting Summary Workflow** (`lark-workflow-meeting-summary`): Aggregate meeting notes
- **Standup Report Workflow** (`lark-workflow-standup-report`): Generate daily standup summaries

See `references/workflows.md` for details.

## Advanced Features

### Custom Skills & Integrations

Use `lark-skill-maker` to create custom skills by wrapping Lark APIs. See `references/skill-maker.md`.

### OpenAPI Discovery

Use `lark-openapi-explorer` to discover and test Lark APIs directly. See `references/openapi.md`.

### Event Subscriptions

Subscribe to real-time events via WebSocket with `lark-event`. See `references/events.md`.

### Other Domains

- **Minutes**: Meeting minutes metadata (`lark-minutes`)
- **Whiteboard**: Drawing/diagram creation with DSL (`lark-whiteboard`)
- **Shared**: Core authentication rules and identity management (`lark-shared`)

See `references/other-domains.md` for details.

## Quick Example

### Send a message to a chat
```bash
# First, find the chat
lark-cli im +chat-search --keyword "engineering"

# Then send a message
lark-cli im +messages-send --chat-id oc_xxx --text "Hello team!"
```

### Search past messages
```bash
lark-cli im +messages-search --query "deadline" --from-user ou_xxx --start-time 2024-01-01 --end-time 2024-01-31
```

### Create a spreadsheet and add data
```bash
lark-cli sheets +spreadsheets-create --title "Q1 Data"
lark-cli sheets +spreadsheets-append --spreadsheet-id spr_xxx --range "Sheet1!A1" --values "[[1,2,3]]"
```

### Query a base table
```bash
lark-cli base +tables-records-list --base-id app_xxx --table-id tbl_xxx --limit 100
```

## Need Help?

- **View all domains**: `lark-cli --help`
- **Domain-specific help**: `lark-cli <domain> --help`
- **Inspect API schema**: `lark-cli schema <domain>.<resource>.<method>`
- **Permission requirements**: Check the permission tables in each domain's reference file

## Next Steps

1. **Choose your domain** from the list above
2. **Read the domain reference** (linked in each section)
3. **Use shortcuts** for common operations
4. **Inspect schemas** if using raw APIs
5. **Check permissions** in the reference documentation

