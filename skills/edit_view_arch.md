---
name: edit_view_arch
summary: Read arch_db once, mutate in memory, write back in a single call. The canonical pattern for any existing page edit.
hint: |
  Use for modifying existing content in a view (brownfield). For adding new snippet
  blocks to a greenfield or empty page, prefer `inject_snippet`. Both skills use
  get_page_arch + set_page_arch — the difference is intent and scope of the edit.
applies_to:
  models: [ir.ui.view]
  operations: [edit, update, website]
tools_used: [get_page_arch, set_page_arch, get_record]
preconditions:
  - You have the `ir.ui.view` id. For a website.page, read `view_id` from the page record first.
  - You know exactly what to change before calling get_page_arch — do not read then decide then read again.
anti_patterns:
  - "Calling get_page_arch multiple times before writing — read once, mutate in memory, write once. Two reads = stale context risk."
  - "Writing partial arch (only the changed section) — set_page_arch replaces the full arch_db. Always write the complete document."
  - "Editing arch_db directly via update('ir.ui.view', id, {arch_db: ...}) — use set_page_arch which validates and normalizes the XML."
  - "Making multiple set_page_arch calls for one logical change — compose all mutations in memory first, write once."
---

# Skill: Edit an existing view arch

## Step 1 — Resolve view id

If you have a `website.page` record id, not an `ir.ui.view` id:
```
get_record('website.page', page_id, fields=['view_id', 'name', 'url'])
```
Capture `view_id[0]` (the integer id). All subsequent calls use the **view id**, not the page id.

## Step 2 — Read arch once

```
get_page_arch(page_id=<view_id>)
```
Hold the full arch string in memory. This is the only read. Do **not** call again.

## Step 3 — Plan all mutations before touching anything

Before editing a single character, enumerate every change:
- What element(s) are targeted (by id, class, data-snippet, or text content)?
- What changes: text content / attribute value / class addition / element insertion / element removal?
- Are there dependencies between changes (e.g. adding a class requires another element to exist first)?

Resolve all ambiguity from the arch you already have. No extra tool calls.

## Step 4 — Apply all mutations in memory

Edit the arch string (or parse as XML mentally, then serialize). Rules:
- **Well-formed XML only:** all tags closed, attributes quoted, no bare `&`.
- **Preserve `data-snippet`, `data-name`, `data-oe-*` attributes** — Odoo's editor uses them for block selection and save tracking.
- **Do not remove `oe_structure` classes** — they mark editable regions.
- **QWeb directives (`t-if`, `t-foreach`, `t-att-*`)**: preserve exactly; mutation of these requires understanding the template logic.

## Step 5 — Write once

```
set_page_arch(page_id=<view_id>, arch='<full mutated arch>')
```
One call. If the XML is invalid, Odoo will reject it and return an error — the original arch is intact.

## Step 6 — Verify

```
get_page_arch(page_id=<view_id>)
```
Confirm the mutations appear exactly as intended. If a mutation is missing, the XML may have been normalized by Odoo — compare to the written string.

## Recovery

If `set_page_arch` corrupts the page (edge case with complex QWeb):
```
get_record('ir.ui.view', view_id, fields=['arch_prev'])
```
`arch_prev` stores the previous arch. Write it back via `set_page_arch` to restore.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `set_page_arch` returns XML parse error | Unclosed tag, unquoted attribute, bare `&` | Fix the XML in memory and retry |
| Change appears but breaks layout | Removed a structural class or wrapper | Restore from `arch_prev`, redo edit preserving structure |
| Edit lost after save in browser editor | Overwrote Odoo-managed `data-oe-*` content | Read arch after browser save, re-apply only your change |
