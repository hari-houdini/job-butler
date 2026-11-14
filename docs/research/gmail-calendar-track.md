# Gmail and Google Calendar for the Track Stage

Research for [issue #5](https://github.com/hari-houdini/job-butler/issues/5): what Gmail and Google Calendar access a Claude Code plugin has, with what auth and scopes, whether it can run unattended, and what it takes to detect Application status changes and interviews.

Researched 2026-11-12. Every claim cites a primary source. Statements marked **(inference)** are my reasoning from those sources. Statements marked **(observed)** come from tool schemas in this Claude Code session; no connector tool was called on any account.

## TL;DR

- **Three routes:** (A) claude.ai Gmail and Google Calendar connectors, which appear in Claude Code automatically; (B) a Gmail or Calendar MCP server bundled in the plugin's `.mcp.json`; (C) a plugin script that calls the Google APIs directly. Route A needs no Google Cloud project and no OAuth code. Routes B and C need the job seeker to create their own Google Cloud OAuth client.
- **Reading works on route A.** You can search Gmail with the full Gmail query syntax, read threads as plain text, list labels, and list, search or get Calendar events. The connectors also include **write** tools (send, trash, label, create or delete events), so Job Butler has to block them itself.
- **Unattended runs are possible but limited.** `/loop` runs only while a session is open and expires after 7 days. Desktop scheduled tasks need the app open and the machine awake. Cloud scheduled tasks need neither, but they start from a fresh repo clone with no local files. True push (Gmail `watch` via Pub/Sub, Calendar `watch` via an HTTPS webhook) needs a GCP project and a public endpoint, so it doesn't fit a local plugin.
- **Detection means polling plus classification.** No API marks a message as "rejection". Track has to search a date window, pre-filter by sender and keywords, have the model classify each message, and match it to an Application by company, domain and role. ATS sender domains help but aren't reliable, because employers send from their own verified domains.
- **v1 recommendation:** route A, run in-session (a `/track` sync skill, optionally `/loop` or a Desktop scheduled task), read-only through a subagent tool allowlist, with every status change proposed to the job seeker for Approval rather than applied silently.

## 1. Ways a plugin can reach Gmail and Calendar

### A. claude.ai connectors in Claude Code

- MCP servers added in claude.ai ("connectors") "are automatically available in Claude Code" when you're logged in with a claude.ai account. You add them at claude.ai/customize/connectors. [code.claude.com/docs/en/mcp#use-mcp-servers-from-claude-ai](https://code.claude.com/docs/en/mcp#use-mcp-servers-from-claude-ai)
- **Auth flow:** OAuth with Google happens once, in claude.ai. "Some Anthropic-hosted connectors, such as Microsoft 365, Gmail, and Google Calendar, don't support local OAuth from Claude Code because the upstream identity provider only accepts the redirect URL that claude.ai registered." [mcp docs](https://code.claude.com/docs/en/mcp#use-mcp-servers-from-claude-ai)
- **Auth requirement:** connectors are fetched only when the active auth method is a claude.ai subscription login. They don't load with `ANTHROPIC_API_KEY`, `apiKeyHelper`, Bedrock or Vertex, or a `CLAUDE_CODE_OAUTH_TOKEN` from `claude setup-token`, "which can only make model requests". [mcp docs](https://code.claude.com/docs/en/mcp#use-mcp-servers-from-claude-ai)
- **Where they reach:** terminal, VS Code, JetBrains and Agent SDK sessions fetch connectors themselves. Cloud sessions get them from the host. Desktop local sessions get them in-process. [mcp docs, "How connectors reach Claude Code"](https://code.claude.com/docs/en/mcp#how-connectors-reach-claude-code)
- **A plugin can't install a connector.** The user connects it in claude.ai. The plugin can only depend on the tool names (inference). Users can turn connectors off with `disableClaudeAiConnectors`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`, or `deniedMcpServers`. [mcp docs](https://code.claude.com/docs/en/mcp#disable-claude-ai-connectors)
- **Scopes:** Anthropic doesn't list the Google OAuth scopes it requests. Its help article says "Google's OAuth screen mentions email sending permissions", so the grant is broader than read-only, and a plugin can't narrow it. [support.claude.com, Google Workspace connectors](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors)
- **Plans and data:** available to all users. On Team and Enterprise plans an Owner must enable the connectors first. "We do not train our models on your Gmail, Drive, or Calendar connector data" (with an exception for consumer users who opted in to training). [support.claude.com](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors)

### B. Bundling a Gmail or Calendar MCP server in the plugin

- Plugins define MCP servers "in `.mcp.json` at the plugin root or inline in `plugin.json`", and Claude Code starts them automatically when the plugin is enabled. Tools are named `mcp__plugin_<plugin>_<server>__<tool>`. [mcp docs, plugin-provided servers](https://code.claude.com/docs/en/mcp#plugin-provided-mcp-servers)
- **Pointing a bundled remote server at Anthropic's hosted Gmail or Calendar endpoint fails**, with "is Anthropic-hosted and doesn't support local OAuth". [mcp docs](https://code.claude.com/docs/en/mcp#use-mcp-servers-from-claude-ai)
- **Remote (HTTP) server option:** Claude Code runs OAuth 2.0 from `/mcp` or `claude mcp login`. It supports pre-registered `--client-id`/`--client-secret` (stored in the keychain), a fixed `--callback-port`, and pinned `oauth.scopes`. [mcp docs, OAuth](https://code.claude.com/docs/en/mcp#authenticate-with-remote-mcp-servers) The MCP spec bases HTTP authorization on OAuth 2.1 with PKCE and protected-resource metadata. [MCP spec, authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- **Local (stdio) server option:** per the MCP spec, stdio servers "SHOULD NOT follow this specification, and instead retrieve credentials from the environment". [MCP spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) The plugin can prompt for a client ID and secret with `userConfig`. `sensitive: true` values go to secure storage and are substituted into the server's `env` with `${user_config.KEY}`. `${CLAUDE_PLUGIN_DATA}` is a persistent directory for tokens and state. [plugins reference](https://code.claude.com/docs/en/plugins-reference#user-configuration)
- **Google-side cost:** the job seeker must create a Google Cloud project and OAuth client. Gmail read scopes are **restricted** (see section 5). An unverified personal-use app (fewer than 100 users) is exempt from verification but shows the "unverified app" warning. [Google: verification exceptions](https://support.google.com/cloud/answer/13464323) If the consent screen stays in "Testing" (external user type), refresh tokens "expire in 7 days". [Google OAuth 2.0](https://developers.google.com/identity/protocols/oauth2) Refresh tokens that carry Gmail scopes are also revoked when the user changes password. [same](https://developers.google.com/identity/protocols/oauth2)

### C. Direct Google APIs from plugin scripts or hooks

- This has the same Google Cloud and OAuth costs as B. A hook or `bin/` script calls the Gmail and Calendar REST APIs and writes results to `${CLAUDE_PLUGIN_DATA}`. Hook processes receive `CLAUDE_PLUGIN_OPTION_<KEY>` for every `userConfig` option. [plugins reference](https://code.claude.com/docs/en/plugins-reference#reference-a-saved-value)
- **The only option with true incremental sync:** Gmail `history.list` from a stored `historyId` [Gmail push guide](https://developers.google.com/workspace/gmail/api/guides/push), and Calendar `syncToken`/`nextSyncToken`. Calendar returns 410 when a full resync is needed, and "the result will always contain deleted entries". [Calendar sync guide](https://developers.google.com/workspace/calendar/api/guides/sync)

## 2. Read capabilities

### Connector tools present in this session (observed)

These are the schemas loaded with ToolSearch. None were called.

| Gmail | Purpose |
|---|---|
| `search_threads` | Gmail query syntax (`from:`, `subject:`, `after:`/`before:`, `newer_than:`, `category:`, `label:`, `OR`, `{}`, `-`, `AROUND`, `rfc822msgid:` and more). Page size up to 50. Views: `THREAD_VIEW_METADATA_ONLY`, `MINIMAL` (subject and snippet), `SUMMARY` (latest message only), `IDS_ONLY`. Returns up to 5 messages per thread, without bodies |
| `get_thread` | All messages in a thread. `messageFormat`: `METADATA_ONLY`, `MINIMAL`, `PLAIN_TEXT` (recommended), `FULL_CONTENT` |
| `get_message`, `list_labels`, `download_gmail_attachment` | Read side |
| `send_message`, `reply`, `forward`, `create_draft`, `trash_*`, `label_*`, `mark_*_spam`, `create_label`, `delete_label`, and others | **Write side.** Track should never call these |

| Calendar | Purpose |
|---|---|
| `list_events` | Per-calendar. Parameters: `startTime`/`endTime` (default now to +7 days), `fullText` (AND match on title, description, location, attendees), `eventType` (includes `FROM_GMAIL`), `orderBy` (`startTime`, `lastModified`, and others), paging. **No `syncToken` parameter** |
| `search_events` | Semantic search over the primary calendar |
| `get_event`, `list_calendars` | Read side |
| `create_event`, `update_event`, `delete_event`, `respond_to_event`, `suggest_time` | **Write side** |

Anthropic's help article lists the same capabilities, including Calendar create, update and delete, and sends that require Approval by default. It says attachment content is "metadata only", which conflicts with the `download_gmail_attachment` tool now present. [support.claude.com](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors)

### Gmail API (routes B and C)

- `messages.list` takes `q` ("same query format as the Gmail search box"), `labelIds` and `includeSpamTrash`. **`q` "cannot be used when accessing the api using the gmail.metadata scope."** [messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- Search operators are documented in [Gmail help 7190](https://support.google.com/mail/answer/7190). That page documents no invite-specific operator. The only calendar hook is `header:`, for example `header:X-Google-Calendar-Notification:...`.
- Quotas: 6,000 units per user per minute. `messages.list` costs 5, `messages.get` costs 20 (60 for full or raw), `threads.get` costs 40 (120 for full), and `history.list` costs 2. [Gmail quota](https://developers.google.com/workspace/gmail/api/reference/quota) That's ample for one job seeker (inference).

## 3. Running unattended

| Mechanism | Runs without open session | Machine off OK | Local files (Profile, Application store) | Connectors | Source |
|---|---|---|---|---|---|
| `/loop` and session cron (`CronCreate`) | No: "Tasks only fire while Claude Code is running and idle". Recurring tasks expire after 7 days | No | Yes | Inherits session | [scheduled-tasks](https://code.claude.com/docs/en/scheduled-tasks) |
| Desktop scheduled task | Yes, but only "while the desktop app is running and your computer is awake". One catch-up run after wake | No | Yes | "Config files and connectors" | [desktop-scheduled-tasks](https://code.claude.com/docs/en/desktop-scheduled-tasks) |
| Cloud scheduled task (formerly routines) | Yes | Yes | **No (fresh clone)** | claude.ai connectors, all included by default; minimum interval 1 hour; auto mode | [routines](https://code.claude.com/docs/en/routines) |
| `claude -p` from OS cron or launchd | Yes | No | Yes | Only with a claude.ai login. **Not** with a `setup-token` token. OAuth "can't run" in `-p`, so sign in interactively first | [mcp docs](https://code.claude.com/docs/en/mcp#use-mcp-servers-from-claude-ai), [authentication](https://code.claude.com/docs/en/authentication) |
| Hooks | Only within a session | No | Yes | `mcp_tool` hooks exist, but at launch "`SessionStart` ... fire[s] before the session's MCP servers are available", so Claude Code skips them | [hooks, MCP tool hook fields](https://code.claude.com/docs/en/hooks) |
| Gmail `users.watch` push | n/a | Needs a server | n/a | Needs a GCP Pub/Sub topic. Renew "at least once every 7 days". Max 1 notification per second per user. Google still recommends polling for user-owned devices | [Gmail push](https://developers.google.com/workspace/gmail/api/guides/push) |
| Calendar `events.watch` push | n/a | Needs a server | n/a | Needs an HTTPS webhook with a valid certificate. Notifications carry no event body. You "still sync even if no push messages are received" | [Calendar push](https://developers.google.com/workspace/calendar/api/guides/push) |

**(inference)** A local plugin can't receive push. Track is effectively "poll when a session or scheduled task runs". A cloud scheduled task could reach Gmail and Calendar with the laptop closed, but only if the Application store lives in the repo it clones and the run commits changes back, which conflicts with keeping the job seeker's data local. That needs its own decision.

## 4. Detecting status changes and interviews

No Google API exposes "this is a rejection". The Gmail category labels (`CATEGORY_UPDATES` and the others) are generic. Track needs a pipeline (inference, shaped by the tool and API facts above):

1. **Candidate fetch.** Use `search_threads` with a date window since the last sync: `after:YYYY/MM/DD` evaluates at midnight, so overlap by a day and dedupe on thread ID (the date semantics are in the connector schema, observed). Because the connector has no `historyId` or `syncToken`, keep `last_synced_at` and processed thread and message IDs in local state. Use `THREAD_VIEW_METADATA_ONLY` or `MINIMAL` first, and pull `PLAIN_TEXT` bodies only for candidates.
2. **Sender pre-filter.** Combine known ATS senders with the employer domains of open Applications:
   - Greenhouse: `no-reply@greenhouse.io`, `no-reply@us.greenhouse-mail.io`, `no-reply@eu.greenhouse-mail.io`, `no-reply@anz.greenhouse.io`. [Greenhouse support](https://support.greenhouse.io/hc/en-us/articles/17675865619099) Employers with verified domains send from their own domain, and Greenhouse adds a `gh-mail` subdomain by default. [Greenhouse domain verification](https://support.greenhouse.io/hc/en-us/articles/11915120413211)
   - Ashby: the default is `no-reply@ashbyhq.com`. Employers with a custom domain replace it "for all default no-reply emails". [Ashby docs](https://docs.ashbyhq.com/email-domain-setup)
   - Workday: the sender is tenant-specific, `<tenant>@myworkday.com`. Universities document `utaustin@myworkday.com` and `wisconsin@myworkday.com`, and the Reply-To is configurable. These are tenant docs, not a Workday spec. [UW–Madison](https://hr.wisc.edu/hr-guides/for-hr-professionals/candidate-message-templates/), [UT Austin](https://workday.utexas.edu/news/job-alerts-email-are-available-again-workday)
   - Lever: **unconfirmed.** I found no Lever help-center page that states the outbound sender domain. `hire.lever.co` appears only for inbound addresses such as `applicant@hire.lever.co`. [Lever help](https://help.lever.co/hc/en-us/articles/20087328710685) Treat `lever.co` and `hire.lever.co` as heuristics to verify against real mail.
   - Example query shape: `newer_than:3d {from:greenhouse.io from:greenhouse-mail.io from:ashbyhq.com from:myworkday.com from:lever.co from:<company-domain> ...}`. Because recruiters write from personal or company addresses, also add `subject:(application OR interview OR offer)` without a sender filter.
3. **Classify.** The model reads the plain-text body and assigns acknowledgement, rejection, interview invite or scheduling, assessment, offer, or other, with confidence and quoted evidence. Keyword pre-filters (for example "thank you for applying", "unfortunately", "move forward", "schedule", "availability", "offer") are design heuristics, not sourced facts.
4. **Match to an Application,** in this order: the stored thread ID from earlier mail, then sender domain against the employer domain, then the company name in the display name, subject or body, then the role title or requisition ID. If more than one Application matches, or none does, ask the job seeker.
5. **Calendar.** Use `list_events` over the coming window (default now to +7 days) and `fullText` with the company name or "interview". Match the organizer and attendee domains to the Application. Interview invites sent by email also appear in Gmail. Calendar API push and `syncToken` are unavailable through the connector.
6. **Apply.** Propose each status change and interview as a diff for Approval. Auto-apply only acknowledgements above a confidence threshold, if the job seeker opts in (design suggestion).

## 5. Privacy and minimum scopes

- **Route A:** scopes are fixed by Anthropic and include send permission. [support.claude.com](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors) Job Butler can still keep Track read-only:
  - Run Track as a subagent with a `tools` allowlist, for example `mcp__claude_ai_Gmail__search_threads`, `get_thread`, `get_message`, `list_labels` and the Calendar `list_*`, `search_events` and `get_event` tools. `disallowedTools` also accepts `mcp__<server>` entries. [sub-agents](https://code.claude.com/docs/en/sub-agents)
  - The user can add `permissions.deny` rules such as `mcp__claude_ai_Gmail__send_message`. [permissions](https://code.claude.com/docs/en/permissions) A plugin's own `settings` only applies `agent` and `subagentStatusLine`, so it **can't ship deny rules**. [plugins reference](https://code.claude.com/docs/en/plugins-reference#settings)
  - Tool names in this session follow the pattern `mcp__claude_ai_Gmail__*` (observed).
- **Routes B and C, the minimum Gmail scopes:**
  - `gmail.readonly` is **restricted**. It's the narrowest scope that allows `q` search and bodies. [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes)
  - `gmail.metadata` is also restricted, gives headers only, and **can't use `q`**. [messages.list](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
  - `gmail.labels` is non-sensitive but can't read mail.
  - Restricted scopes need verification and, if data is stored or transmitted on servers, an annual security assessment. [Gmail scopes](https://developers.google.com/workspace/gmail/api/auth/scopes), [Google verification](https://support.google.com/cloud/answer/13464321) A single job seeker's own project falls under the personal-use exemption. [Google exceptions](https://support.google.com/cloud/answer/13464323)
- **Routes B and C, the minimum Calendar scope:** `calendar.events.readonly` ("View events on all your calendars"), or `calendar.events.owned.readonly` for owned calendars only. [Calendar scopes](https://developers.google.com/workspace/calendar/api/auth)
- **Data minimisation (design):** store only derived facts (thread ID, date, classification, quoted evidence line, matched Application) in the local store, not full bodies. Connector-retrieved data is also stored with the chat on claude.ai's side. [support.claude.com](https://support.claude.com/en/articles/10166901-use-google-workspace-connectors)

## Recommended v1 approach

**Use route A, the claude.ai connectors, in-session and read-only, with Approval on every write to Application state.**

- The plugin ships a Track subagent whose `tools` allowlist contains only the read tools listed in section 5, plus a `/track` sync skill that runs the pipeline in section 4.
- Local state (`last_synced_at`, processed IDs, thread-to-Application map) lives in the project's Application store or `${CLAUDE_PLUGIN_DATA}`.
- For "automatic" updates, the user runs `/loop 2h /track` during a work session, or creates a Desktop scheduled task that runs `/track` daily. Both are documented and keep data local.
- Setup check: on first run, detect whether `mcp__claude_ai_Gmail__*` tools exist. If not, tell the job seeker to connect Gmail and Calendar at claude.ai/customize/connectors and log in with a claude.ai account (not an API key).

**Limits of v1:**

- Updates happen only when a session or Desktop task runs. There's no real-time push, and no runs while the machine is off or asleep (Desktop gives one catch-up run on wake).
- It requires a claude.ai subscription login. API-key, Bedrock or Vertex users and `setup-token` CI tokens get no connectors.
- The Google grant includes send permission. Read-only behaviour is enforced by Job Butler's subagent allowlist, not by Google scopes.
- There's no incremental-sync primitive. Date-window polling with local dedupe can miss or double-handle edge cases, and `search_threads` caps at 50 per page.
- Classification is probabilistic, and ATS sender domains are a weak signal. Ambiguous matches need the job seeker.
- Team and Enterprise accounts need an Owner to enable the connectors.

**When to revisit:** use route B or C (your own OAuth client with `gmail.readonly` and `calendar.events.readonly`) if narrow scopes, true incremental sync, or non-claude.ai auth become requirements. Use cloud scheduled tasks if Track must run with the laptop closed and the Application store can live in a private repo.

## Open questions surfaced

1. Can the Application store live in a (private) git repo so cloud scheduled tasks can run Track, or must it stay local? This decides whether laptop-off tracking is possible.
2. Which status changes may Track apply without Approval, if any (for example acknowledgements)?
3. Is a claude.ai subscription login an acceptable hard requirement for Track, or must Job Butler also support API-key users (which forces route B or C)?
4. Does a `claude -p` run from OS cron with the stored claude.ai login reliably load connectors? The docs imply yes but don't state it, so it needs a quick test.
5. What are Lever's real outbound sender domain and the common scheduling-tool senders? Verify them against sample mail before hard-coding a sender list.
