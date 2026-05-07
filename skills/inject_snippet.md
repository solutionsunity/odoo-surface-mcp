---
name: inject_snippet
summary: Fetch a canonical snippet and inject it into a Website view arch.
hint: |
  NEVER use this for backend views. Only for Website/QWeb templates.
  Always source HTML from `get_snippet`.
applies_to:
  models: [ir.ui.view]
  operations: [create, edit, inject, website]
tools_used: [list_snippets, get_snippet, get_page_arch, set_page_arch]
preconditions:
  - "The view is a Website or QWeb template (Type: qweb)."
  - "You have the ir.ui.view id (or the website.page view_id)."
  - "The snippet name is known or discovered via list_snippets."
anti_patterns:
  - "Editing backend form/tree/search views."
  - "Hand-writing snippet outer wrapper HTML from memory."
  - "Replacing the entire arch_db with only the new snippet — you lose all existing content."
---

# Skill: Inject a snippet into a Website/QWeb arch

## Rule Zero: Scope Validation

Before proceeding, confirm the view type.
- **ALLOWED:** `website`, `qweb`, `report`.
- **FORBIDDEN:** `form`, `tree`, `kanban`, `search`.
Snippets are designed for the Website editor; injecting them into backend views is invalid.

## Step 1 — Discover available snippets

```
list_snippets()
```
Returns snippet names and categories. Identify the snippet you need (e.g. `s_text_image`, `s_banner`, `s_three_columns`).

## Step 2 — Fetch canonical HTML

```
get_snippet(name='<snippet_name>')
```
Returns the full canonical HTML block including all required `data-snippet`, `data-name`, and class attributes. This is the authoritative source — do not modify the outer wrapper.

## Step 3 — Read current arch

```
get_page_arch(page_id=<view_id>)
```
Returns the full current `arch_db`. Hold this in memory — you will write back a modified version. Do **not** call `get_page_arch` again after editing.

## Step 4 — Identify injection point

Locate the correct parent container in the arch. Typical targets:
- Main content wrapper: `<div id="wrap">` or `<div class="oe_structure">`
- After a specific existing snippet block: find by `data-snippet` attribute
- End of wrapping div: append before closing `</div>`

## Step 5 — Compose the new arch in memory

Insert the snippet HTML at the injection point. Rules:
- **Preserve all existing content** — only add, do not remove.
- **Preserve outer wrapper exactly as returned by `get_snippet`** — do not strip `data-*` attrs.
- Fill in editable text/image placeholders inside the snippet with actual content.
- Validate the resulting XML is well-formed before writing (balanced tags, quoted attrs).

## Step 6 — Write back in a single call

```
set_page_arch(page_id=<view_id>, arch='<full modified arch>')
```
One call. If this fails, the original arch is intact — diagnose and retry with corrected XML.

## Step 7 — Verify

```
get_page_arch(page_id=<view_id>)
```
Confirm the snippet appears at the expected position with its `data-snippet` attribute intact.
Optionally visit the page URL in the browser for visual confirmation.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Snippet renders but editor can't select it | Outer `data-snippet` / `data-name` stripped | Re-inject using exact HTML from `get_snippet` |
| Page breaks (white screen / 500) | Malformed XML written to arch | Restore from `arch_prev` field on `ir.ui.view` or fix XML and re-write |
| Snippet injected but invisible | Missing wrapping `oe_structure` class or wrong parent | Move injection point to a valid `oe_structure` div |
