# Odoo compatibility

Every Odoo call the surface makes, checked against each supported series. This file is the
source of truth for version behaviour; code changes that touch a call update its row.

**Scope.** Series 15.0–20.0, Community source (`odoo/odoo`, branch per series). Enterprise and
SaaS series are covered where they share the Community code path; EE-only modules are out of
scope. Source citations are `<series>/<path>:<line>` in that series' tree.

**Live.** `scripts/smoke-compat.mjs <env-file>` drives the built server against every target and
checks each tool's result shape. Live targets: CE 15.0, 17.0, 18.0. 16.0, 19.0, 20.0 are
source-verified only.

**Legend.** `ok` — works as the code uses it. `D<n>` — divergence, described below.

---

## Calls

### Transport and session

| Call | Used by | 15.0 | 16.0 | 17.0 | 18.0 | 19.0 | 20.0 |
|---|---|---|---|---|---|---|---|
| route `/web/session/authenticate` → `uid`, `server_version_info` | `odooClient.session()` | ok | ok | ok | ok | ok | ok |
| route `/web/dataset/call_kw` | `odooClient.execute()` | ok | ok | ok | ok | ok | ok |
| route `/web/webclient/version_info` | `odooClient.ping()` | ok | ok | ok | ok | ok | ok |
| route `/web/dataset/call_button` | `execute_action` | ok | ok | ok | ok | ok | ok |
| route `/web_editor/attachment/add_data` → `{id, name}` | `fetch_and_upload` (new) | ok | ok | ok | ok | ok | ok |

`add_data` moved from `web_editor` to `html_editor` in 18.0 (`18.0/addons/html_editor/controllers/main.py:327`);
the path and signature are unchanged.

### Generic ORM (any model)

| Call | Used by | 15.0 | 16.0 | 17.0 | 18.0 | 19.0 | 20.0 |
|---|---|---|---|---|---|---|---|
| `create` | `create` | ok | ok | ok | ok | ok | ok |
| `read` | `get_record`, `create`, `get_available_actions` | ok | ok | ok | ok | ok | ok |
| `readBinary` (`src/odoo/binary.ts`) | `download_binary` | ok | ok | ok | ok | ok | ok |
| `write` | `update`, `archive`, `upload_binary` | ok | ok | ok | ok | ok | ok |
| `search_read`, `search_count` | `list_records`, `search_records` | ok | ok | ok | ok | ok | ok |
| `name_search` (domain positional) | `search_records` | ok | ok | ok | ok | ok | ok |
| `fields_get` | `get_fields`, `get_defaults`, `update`, `archive`, `inspect_fields`, `odooClient.validFieldNames()` | ok | ok | ok | ok | ok | ok |
| `default_get` | `get_defaults` | ok | ok | ok | ok | ok | ok |
| `views` → `{arch, fields}` (`src/odoo/views.ts`) | `viewFieldNames()`, `get_models`, `get_model_actions`, `get_model_interface`, `inspect_view`, `inspect_action` | ok | ok | ok | ok | ok | ok |
| button visibility (`invisible` in arch) | `get_available_actions` | D3 | D3 | ok | ok | ok | ok |
| `hasAccess` (`src/odoo/access.ts`) | `get_model_actions`, `get_model_interface`, `get_available_actions` | ok | ok | ok | ok | ok | ok |
| `get_field_translations` | `translation_get`, `translation_audit` | D2 | ok | ok | ok | ok | ok |
| `update_field_translations` | `translation_update` | D2 | ok | ok | ok | ok | ok |
| `message_post` | `post_message` | ok | ok | D9 | D9 | D9, D10 | D9, D10 |

### Specific models

| Call | Used by | 15.0 | 16.0 | 17.0 | 18.0 | 19.0 | 20.0 |
|---|---|---|---|---|---|---|---|
| `ir.model.search` | `odooClient.getModelId()` | ok | ok | ok | ok | ok | ok |
| `ir.ui.menu.search_read` | `get_models` | ok | ok | ok | ok | ok | ok |
| `ir.actions.act_window.search_read`, `.read` | `get_models`, `get_model_actions`, `list_records`, `search_records`, `get_defaults` | ok | ok | ok | ok | ok | ok |
| `ir.actions.actions.read`, `<action type>.read` | `execute_action` | ok | ok | ok | ok | ok | ok |
| `ir.actions.server.search_read`, `.run` | `get_model_actions`, `inspect_action`, `execute_action` | ok | ok | ok | ok | ok | ok |
| `ir.actions.report.search_read` | `get_model_actions`, `inspect_action` | ok | ok | ok | ok | ok | ok |
| `ir.filters.search_read` | `get_filters` | ok | ok | ok | ok | ok | ok |
| `ir.ui.view.search_read` | `list_snippets`, `get_snippet` | ok | ok | ok | ok | ok | ok |
| `ir.ui.view.read`, `.write` (`arch_db`) | `get_page_arch`, `set_page_arch` | ok | ok | ok | ok | ok | ok |
| `ir.attachment.search_read` | `list_attachments` | ok | ok | ok | ok | ok | ok |
| `writeAttachmentContent` (`src/odoo/binary.ts`) | `fetch_and_upload` (replace) | ok | ok | ok | ok | ok | ok |
| `website.page.search_read` | `list_pages` | ok | ok | ok | ok | ok | D12 |
| `website.page.read`, `.write` (`is_published`) | `get_page_arch`, `set_page_visibility` | ok | ok | ok | ok | ok | ok |
| `mail.activity.type.search_read` | `schedule_activity` | ok | ok | ok | ok | ok | ok |
| `mail.activity.create` | `schedule_activity` | ok | ok | ok | ok | D11 | D11 |

Fields read or written by the calls above exist in every series unless a divergence names them.

---

## Divergences

Each divergence is handled by one operation in `src/odoo/` (see `docs/architecture.md`) — or,
where one call form works on every series, by using that form (*call form*). Status: **open**
until handled and the row reads `ok` across the supported range.

| # | Series | Divergence | Status |
|---|---|---|---|
| D1 | 15.0 | No `get_views` | `views` |
| D2 | 15.0 | No field-translation API | open |
| D3 | 15.0, 16.0 | Conditional visibility is a domain, not an expression | open |
| D4 | 18.0+ | `get_views` wraps model fields | `views` |
| D5 | 18.0+ | View type `tree` renamed `list` | `views` |
| D6 | 18.0+ | `check_access_rights` deprecated, removed in 20.0 | `hasAccess` |
| D7 | 19.0+ | `res.users.groups_id` renamed | call removed |
| D8 | 19.0+ | `name_search` `args` renamed `domain` | call form |
| D9 | 17.0+ | `message_post` escapes a plain-string body | open |
| D10 | 19.0+ | `message_post` returns `[id]` | open |
| D11 | 19.0+ | `mail.activity.user_id` no longer defaults to the caller | open |
| D12 | 20.0 | `website.page.url` translatable | open |
| D13 | 20.0 | Binary fields read as an object | `readBinary` |
| D14 | 20.0 | `ir.attachment.datas` removed | `writeAttachmentContent` |
| X1 | all | Divergences fail silently | open — `views`, binary, access callers done |
| X2 | 20.0 | Guidance names `ir.attachment.datas` | open |

**D1 — 15.0: no `get_views`.** 15.0 offers `load_views(views, options)` (`15.0/odoo/models.py:1626`),
returning `{fields_views: {<type>: {arch, fields}}, fields}`. `get_views` arrives in 16.0, where
`load_views` becomes deprecated (`16.0/odoo/addons/base/models/ir_ui_view.py:2754`).
Effect: view buttons and `inspect_view` error; `list_records` / `get_record` fall back to
`display_name`; `get_fields` returns `[]`; `getFormFields` falls back to all fields.

**D2 — 15.0: no field-translation API.** Translations live in `ir.translation`
(`15.0/odoo/addons/base/models/ir_translation.py:150`): `name` = `"<model>,<field>"`, `res_id`, `lang`,
`type` (`model` | `model_terms`), `src`, `value`, `state`.
- Read: `ir.translation.search_read` on `name`, `res_id`, `lang`; `src` → `source`. Rows exist only
  once inserted — `translate_fields(model, id, field)` (`:717`, public, used by the 15.0 web client)
  inserts missing ones.
- Write, `translate=True` char/text: write the record with context `{lang}` (`15.0/odoo/fields.py:1638`).
- Write, callable translate (html / xml, incl. `ir.ui.view.arch_db`): write `value` on the
  `model_terms` row matched by `src`. Writing the record with a `lang` context overwrites the
  source (`15.0/odoo/fields.py:1634`).

**D3 — 15.0, 16.0: conditional visibility is a domain.** 17.0+ keeps `invisible` on the node as a
Python expression, which `get_available_actions` evaluates. 15.0 holds conditions in `attrs`
(domain) and folds them into a JSON `modifiers` attribute
(`15.0/odoo/addons/base/models/ir_ui_view.py:82`); 16.0 additionally pops `attrs`, `states` and
`invisible` (`16.0/odoo/addons/base/models/ir_ui_view.py:82`, `:89`, `:100`).
Effect: on 15.0/16.0 every button reports visible.

**D4 — 18.0+: `get_views` wraps model fields.** `models[model]` is `{fields: {...}}`
(`18.0/odoo/addons/base/models/ir_ui_view.py:2631`); 16.0/17.0 return the field map itself.
Effect: `get_models` related-model discovery returns `[]`; `get_model_interface` nests `fields.fields`.

**D5 — 18.0+: view type `tree` is `list`.** `ir.ui.view.type` selection renamed
(`18.0/odoo/addons/base/models/ir_ui_view.py:153`); 18.0+ no longer maps `tree`, and
`get_views([[false,'tree']])` raises `UserError` (`18.0/odoo/addons/base/models/ir_ui_view.py:2713`).
`list` is accepted on every series: 15.0–17.0 map it to `tree` themselves
(`15.0/odoo/models.py:1641`, `16.0/odoo/addons/base/models/ir_ui_view.py:2522`).
Effect: `list_records` default columns collapse to `display_name`.

**D6 — 18.0+: `check_access_rights`.** Deprecated with a warning in 18.0 (`18.0/odoo/models.py:4512`)
and 19.0 (`19.0/odoo/orm/models.py:4167`); absent in 20.0. Replacement: `has_access(operation)`,
public from 18.0 (`18.0/odoo/models.py:4459`). `check_access` is `@api.private` from 19.0 — not usable.
Effect on 20.0: `can_create` / `can_write` / `can_delete` always `false`.

**D7 — 19.0+: `res.users.groups_id` → `group_ids`.** `group_ids` holds explicit groups only;
effective groups are `all_group_ids` (`19.0/odoo/addons/base/models/res_users.py:257`). Reading
`groups_id` raises. Effect: `get_available_actions` errors. Note: the server already strips the
`groups` attribute from returned arch (e.g. `17.0/odoo/addons/base/models/ir_ui_view.py:1023`), so
the client-side group check has nothing to evaluate — on 15.0 too
(`15.0/odoo/addons/base/models/ir_ui_view.py:1007`). The check and its `groups_id` read are removed.

**D8 — 19.0+: `name_search(name, domain, operator, limit)`.** The `args` keyword is renamed
`domain` (`19.0/odoo/orm/models.py:1527`); `args=` raises `TypeError`. Positional domain works on
15.0–20.0.

**D9 — 17.0+: `message_post` escapes a plain-string body.** HTML sent as `body` is stored escaped
unless `body_is_html=True` (`17.0/addons/mail/models/mail_thread.py:2224`). 15.0/16.0 store it as HTML.

**D10 — 19.0+: `message_post` returns `[id]`.** `@api.returns` is dropped
(`19.0/addons/mail/models/mail_thread.py:2199`) and `call_kw` returns recordsets as `.ids`
(`19.0/odoo/service/model.py:104`).

**D11 — 19.0+: activity assignee.** `user_id` has no default and is not required
(`19.0/addons/mail/models/mail_activity.py:88`); the fallback to the current user is an onchange,
which RPC `create` does not run. 20.0 computes it from the activity type's default user
(`20.0/addons/mail/models/mail_activity.py:121`). Effect: activities created unassigned.

**D12 — 20.0: `website.page.url` is translatable** (`20.0/addons/website/models/website_page.py:50`).
`list_pages` returns the URL in the request language.

**D13 — 20.0: binary fields read as an object.** `{filename?, content, size}`
(`20.0/odoo/orm/fields_binary.py:134`); 15.0–19.0 return a base64 string. Effect: `download_binary`
writes a corrupt file and reports success.

**D14 — 20.0: `ir.attachment.datas` removed.** Content fields are `raw` and `db_datas`
(`20.0/odoo/addons/base/models/ir_attachment.py:616`). Writing `datas` is dropped with a warning when
`mimetype` is also written, otherwise raises. Effect: in-place replace reports success without
replacing.

**X1 — divergences fail silently.** Several call sites catch the error and return a plausible
value: `viewFieldNames()` returns `[]` and caches it, `checkAccess()` returns `false`,
`getFormFields()` falls back to all fields, `download_binary` and `fetch_and_upload` report success.
A divergence must surface as an error, never as an empty or partial result.

**X2 — 20.0: guidance names `ir.attachment.datas`.** Skills and workflows instruct agents to read or
write `datas` directly through generic tools (`skills/upload_attachment.md`,
`skills/migrate_binary_field.md`, `workflows/create_blog_post.md`,
`workflows/website_page_with_assets.md`). On 20.0 the field is `raw` (D14). Guidance must route
content through the tools that hide the field (`fetch_and_upload`, `download_binary`,
`upload_binary`) or state the field per series.
