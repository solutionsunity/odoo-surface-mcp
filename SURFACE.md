# OdooSurface MCP - Tool Surface

## Core Contract

The agent may only do what the authenticated user can do in their browser.
Scope is bounded by the user menus, views, and ACL - nothing more.
Tool verbs are functional intents (publish, confirm) not ORM operations (write is_published=True).
Discovery is lazy - the agent resolves only what it needs for the current prompt.

---

## Layer 1 - Discovery

Runs at intent-resolution time. Establishes the bounded universe before any action is planned.

| Tool | Signature | Returns | Source in Odoo |
|---|---|---|---|
| `get_models` | `get_models()` | Primary models: [{model, name, menu_path, action_id}] bounded to user menus | ir.ui.menu -> ir.actions.act_window -> res_model filtered by groups_id |
| `get_models` | `get_models(base="blog.post")` | Related models as relational fields on blog.post: [{model, name, field, field_type}] | Relational fields visible in the blog.post form view for this user |
| `get_model_actions` | `get_model_actions(model, action_id)` | {can_create, can_write, can_delete, server_actions[], reports[], view_buttons[]} | ir.model.access + ir.actions.server (binding) + form view buttons - exploratory |

---

## Layer 2 - Planning Bridge

Runs once a specific record is identified. Answers what can be done right now on this record.

| Tool | Signature | Returns | Why separate from Layer 1 |
|---|---|---|---|
| `get_available_actions` | `get_available_actions(model, record_id, action_id)` | [{name, label, type}] buttons/actions visible for this record current state | Button visibility depends on record state. Layer 1 gives the universe; this gives what is live now. |

---

## Layer 3 - Supporting Tools

Called silently by the agent to fill data needs. Never directly triggered by the user.

| Tool | Purpose |
|---|---|
| `list_records` | Paginated records visible in list/kanban view for a given action |
| `get_record` | Visible fields of a single record (form view, this user) |
| `search_records` | Find records matching a condition within an action domain |
| `get_fields` | Visible + writable fields on a model in a given view context |
| `get_defaults` | What default_get would return for a new record in this action context |
| `get_filters` | Standard filters + saved searches available for a list action |

---

## Layer 4 - Primary Intent Tools

Execution. Called directly in response to what the user asked for.

| Tool | User Intent | Notes |
|---|---|---|
| `create` | Create a new X | default_get -> fill fields -> save. Returns {id} + computed fields (e.g. website_url) |
| `update` | Change / edit X | Only fields writable in form view. Runs onchange before write. |
| `execute_action` | Do X to this record | Confirm, publish, validate, approve, send - named by button label, not method name |
| `archive` | Remove / deactivate X | Only if Archive is a visible action for this user on this model |
| `post_message` | Message / note on X | mail.thread: to followers (message) or internal only (log note) |
| `schedule_activity` | Schedule X on Y | mail.activity: type, deadline, assigned user |
| `upload_file` | Attach a file to X | ir.attachment linked to record. Returns {public_url} for media, chatter entry for documents |

---

## Planning Loop

    User Prompt
      |
      |-- get_models()                          # what models does this user have access to?
      |-- get_models(base="blog.post")          # what related models are reachable from here?
      |
      |-- get_model_actions(model, action_id)   # what can be done on this model in this context?
      |
      |-- [if specific record needed]
      |    |-- search_records / list_records    # find or confirm the record
      |    +-- get_available_actions(record_id) # what is actually live right now on it?
      |
      +-- execute primary intent tool(s)

---

## Open / Deferred

| Area | Status |
|---|---|
| Multi-record actions — actions applied to a list selection | Not implemented |
| upload_file — ir.attachment via binary upload | Not implemented |
| Wizard return chaining — auto-follow when execute_action returns a new wizard | Not implemented |
