---
name: translate_website_page
summary: End-to-end translation of a website.page record (page name, SEO metas, view arch) into a target language.
skills: [translate_char_field, translate_html_field]
applies_to:
  models: [website.page, ir.ui.view]
  operations: [translate]
preconditions:
  - Target language is installed and active in res.lang (`search_records('res.lang', [['code','=','<lang>'], ['active','=',true]])`).
  - Language is published on the website (`website.language_ids` includes the target lang).
  - Caller has write access to ir.ui.view (same ACL as website.page editor).
---

# Workflow: Translate a `website.page` record

`website.page` is a metadata wrapper. All translatable content lives on the related `ir.ui.view` record accessed via `view_id`. This workflow sequences the indirection correctly.

## Field map

| Model | Field | `translate=` | Skill |
|---|---|---|---|
| `website.page` | `name` | `True` | `translate_char_field` |
| `website.page` | `website_meta_title` | `True` | `translate_char_field` |
| `website.page` | `website_meta_description` | `True` | `translate_char_field` |
| `website.page` | `website_meta_keywords` | `True` | `translate_char_field` |
| `ir.ui.view` | `name` | `True` | `translate_char_field` |
| `ir.ui.view` | `arch_db` | `xml_translate` | `translate_html_field` |

SEO meta fields (`website_meta_*`) may be empty — skip `translation_update` for any field whose source is empty or `false`.

## Procedure

### Step 1 — Resolve view_id

```
get_record('website.page', page_id, fields=['name', 'url', 'view_id', 'website_meta_title', 'website_meta_description', 'website_meta_keywords'])
```
Capture `view_id[0]` (integer). All `ir.ui.view` calls use this id.

### Step 2 — Translate page-level char fields

Apply skill `translate_char_field` for each non-empty field on `website.page`:

1. `translation_update('website.page', page_id, 'name', translations={'<lang>': '<translated>'})`
2. If `website_meta_title` is set: `translation_update('website.page', page_id, 'website_meta_title', ...)`
3. If `website_meta_description` is set: same pattern.
4. If `website_meta_keywords` is set: same pattern.

Use `translation_get` first only if you need to confirm existing translations before overwriting.

### Step 3 — Translate view name

Apply skill `translate_char_field` on `ir.ui.view`:
```
translation_update('ir.ui.view', view_id, 'name', translations={'<lang>': '<translated view name>'})
```
View name is typically the internal template identifier — translate to a meaningful equivalent or keep as-is if it is a technical key.

### Step 4 — Translate arch_db

Apply skill `translate_html_field` (covers `xml_translate`):
1. `translation_get('ir.ui.view', view_id, 'arch_db', langs=['<lang>'])` → returns N text-node terms.
2. Save to `tmp/view_<view_id>_arch_db_<lang>.json` with `_meta` block.
3. Fill every `value`. Preserve QWeb directives (`t-if`, `t-esc`, `t-out`) — they appear as context but must not be translated. Translate only human-visible text nodes.
4. `translation_update('ir.ui.view', view_id, 'arch_db', translations={'<lang>': {source_1: value_1, ...}})` — single call, all terms.

### Step 5 — Verify all fields

```
translation_get('website.page', page_id, 'name', langs=['<lang>'])
translation_get('ir.ui.view', view_id, 'arch_db', langs=['<lang>'])
```
Every pushed term must have a non-empty `value`. Empty entries indicate source-key mismatch — re-extract and retry.

### Step 6 — Visual check

Visit `/<lang_code>/<page_url>` (e.g. `/ar/about-us`) to confirm the translated page renders. RTL languages apply automatically if `res.lang.direction = 'rtl'`.

## Out of scope (handle separately)

- **Images with alt text**: `alt` attributes inside arch are translatable via `TRANSLATED_ATTRS` — they appear as terms in `translation_get`. Translate them with the arch terms in Step 4.
- **Menus pointing to this page**: `website.menu.name` is a separate char field — translate via `translate_char_field` on `website.menu`.
- **Child pages**: each page is translated independently; this workflow covers one page at a time.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `/<lang>/page-url` returns 404 | Language not published on website | Add lang to `website.language_ids` |
| Arch terms appear empty after update | Source key mismatch (QWeb normalized the string) | Re-run `translation_get` after writing; use its returned source keys exactly |
| SEO meta not reflected in `<head>` | Field empty in source lang; translation skipped | Confirm source value exists before pushing translation |
