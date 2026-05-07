---
name: create_website_page
summary: Create a new website.page with URL, structured arch content built from snippets, and optional SEO meta.
skills: [upload_attachment, inject_snippet, edit_view_arch]
applies_to:
  models: [website.page, ir.ui.view]
  operations: [create]
preconditions:
  - A website record exists (`search_records('website', [], fields=['id','name'])` to confirm).
  - Page is created in the source language. For multilingual publishing, run `translate_website_page` after editorial review.
  - Target URL does not conflict with an existing page (`search_records('website.page', [['url','=','/<slug>']])` returns empty).
---

# Workflow: Create a `website.page`

Source-language only. Translation is a separate lifecycle step — see `translate_website_page`.

## Step 1 — Confirm URL availability

```
search_records('website.page', [['url', '=', '/<slug>']], fields=['id', 'name'])
```
Must return empty. If not, choose a different slug or update the existing page.

## Step 2 — Create the page

```
create('website.page', {
  name: '<Internal view name>',
  url: '/<slug>',
  is_published: false,
  website_indexed: true
})
```
Returns: `{ id: <page_id> }`

Odoo automatically creates a linked `ir.ui.view` record. Retrieve it:
```
get_record('website.page', <page_id>, fields=['view_id', 'name', 'url'])
```
Capture `view_id[0]` — this is the view id for all arch operations.

## Step 3 — Read initial arch

```
get_page_arch(page_id=<view_id>)
```
Odoo generates a minimal default arch. Hold it in memory as your starting point.

## Step 4 — Build content from snippets

Apply skill `inject_snippet` for each content block:

1. `list_snippets()` — identify needed snippets (e.g. `s_banner`, `s_text_image`, `s_three_columns`).
2. `get_snippet(name='<snippet>')` — fetch canonical HTML for each.
3. Compose the full arch in memory: start from the initial arch (Step 3), insert snippet blocks at correct positions inside the `oe_structure` container.
4. Fill editable text/image placeholders with actual content.
5. Validate XML mentally (balanced tags, quoted attrs, no bare `&`).

## Step 5 — Upload images (if any)

Apply skill `upload_attachment` for each image used in the page:

```
fetch_and_upload(query='<search>', model='website.page', record_id=<page_id>)
```
Or binary/URL paths per the skill. Capture `/web/image/<id>` URLs and substitute into the arch `src` attributes.

## Step 6 — Write arch

```
set_page_arch(page_id=<view_id>, arch='<full composed arch>')
```
Single call with the complete arch including all snippets and real content.

## Step 7 — Set SEO meta (optional)

```
update('website.page', <page_id>, {
  website_meta_title: '<SEO title>',
  website_meta_description: '<Meta description>',
  website_meta_keywords: '<keyword1, keyword2>'
})
```

## Step 8 — Add to navigation menu (optional)

```
create('website.menu', {
  name: '<Menu label>',
  url: '/<slug>',
  parent_id: <parent_menu_id>,   # search_records('website.menu', [['parent_id','=',false]]) for root menus
  website_id: <website_id>
})
```

## Step 9 — Publish

Only when content is reviewed and ready:
```
update('website.page', <page_id>, {is_published: true})
```

## Verify

```
get_record('website.page', <page_id>, fields=['name', 'url', 'is_published'])
get_page_arch(page_id=<view_id>)
```
Visit `/<slug>` to confirm the page renders with expected content.

## Next step

To translate into other languages: run workflow `translate_website_page`.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `create('website.page')` fails with URL conflict | URL already taken | Use a different slug or update existing page |
| Page renders blank | `oe_structure` container missing or arch empty | Re-inject snippets; ensure arch has valid `oe_structure` wrapper |
| Images show broken link | Attachment not `public: true`, or wrong URL format | `update('ir.attachment', id, {public: true})`; use `/web/image/<id>` format |
| Page not visible at URL | `is_published` still false | `update('website.page', id, {is_published: true})` |
