---
name: website_page_with_assets
summary: >
  Build or maintain an Odoo website page whose JS/CSS/fonts/data live as
  ir.attachment records. Covers the full lifecycle: asset upload, page arch
  wiring, access restriction, and all known Odoo Website gotchas discovered
  in production (UAC Atlas project, May 2026).
applies_to:
  models: [website.page, ir.ui.view, ir.attachment]
  operations: [create, update, read]
skills: [upload_asset, edit_view_arch]
---

# Website Page with Attachment Assets — Field Guide

## 0 — Layer 0 FIRST (non-negotiable)

Before writing a single line of code, call:
```
list_workflows   →  multi-step recipes
find_skill("<what you need>")  →  single-op canonical paths
```
Every common operation (upload, translate, edit arch, inject snippet) already
exists. Hand-rolling = rebuilding tested code. No exceptions.

---

## 1 — Architecture

```
website.page  →  ir.ui.view (arch_db)
                      │
                ┌─────┴──────────────────────┐
                │  <t t-set="head">           │
                │    <link href="/web/content/{css_id}"/>
                │    <script src="/web/content/{js_id}"/>
                │  </t>                       │
                │  <div id="app-root"         │
                │       data-manifest-id="{id}">
                │    … static shell …         │
                │  </div>                     │
                └─────────────────────────────┘
                      │
              ir.attachment (JS, CSS, fonts, JSON, HTML)
              served via /web/content/{id}
              served via /web/image/{id}  (images only)
```

- All JS/CSS/fonts/data are **ir.attachment** records — zero static files.
- Page logic lives entirely in the JS attachment; `arch_db` is the shell only.
- `data-*` attributes on the root div pass IDs (manifest, config) to JS.

---

## 2 — Asset Upload & Update

### New asset (any file type)
```
fetch_and_upload(source="/absolute/local/path/file.js",
                 is_image=false, public=true)
→ {id, src}   ← use id in arch_db script/link tags
```
- MCP server handles the transfer. **No base64 through AI context.**
- `public=true` required for any website-facing asset.

### Replace in-place (keep same URL, no arch update needed)
```
fetch_and_upload(source="/path/updated.js",
                 attachment_id=<existing_id>,
                 is_image=false, public=true)
```
- Overwrites `datas` on the same record. URL `/web/content/{id}` stays valid.
- **Never** create a new attachment to replace — old arch references break.

### Reference in arch_db
```xml
<link rel="stylesheet" href="/web/content/{css_id}"/>
<script type="text/javascript" src="/web/content/{js_id}"/>
<!-- Images → /web/image/{id}  |  Everything else → /web/content/{id} -->
```

---

## 3 — Page Arch Pattern

```xml
<t t-name="my.page" t-call="website.layout">
  <t t-set="head">
    <link rel="stylesheet" type="text/css" href="/web/content/{css_id}"/>
    <script type="text/javascript">
      /* Inline theme-flash only — kept tiny, CSP-safe */
      (function(){try{var s=localStorage.getItem('theme');
        document.documentElement.setAttribute('data-theme',s||'light');
      }catch(e){}}());
    </script>
    <script type="text/javascript" src="/web/content/{js_id}"/>
  </t>
  <div id="app-root" data-manifest-id="{manifest_attachment_id}">
    <!-- static shell; JS renders into this -->
  </div>
</t>
```

- Use `get_page_arch` → edit in memory → `set_page_arch` (one write).
- `website.page` is metadata only; content lives on `ir.ui.view.arch_db`.

---

## 4 — Known Gotchas (from UAC Atlas)

### 4.1 DOM Stripping — hidden elements vanish
**Symptom:** `getElementById('field-inside-hidden-div')` → null at script load.
**Cause:** Odoo's website publisher strips elements inside `hidden=""` or
`display:none` from the live DOM during page init, before your scripts run.

**Fix — two options:**
1. **Lazy init:** expose `window.myInit()`, call it only when the hidden panel
   becomes visible (e.g. on tab click). Guard with `_initialized` flag.
2. **JS injection:** inject the hidden element's HTML via JS at runtime instead
   of placing it in `arch_db`.

**Rule:** Never query DOM elements that start hidden at page load inside an IIFE
or DOMContentLoaded. Re-query them at the moment of first use.

---

### 4.2 Inline onclick / functions blocked by CSP
**Symptom:** `ReferenceError: myFunction is not defined` on button click.
**Cause:** Odoo's CSP nonce policy blocks inline `<script>` blocks in page body.
Inline `onclick="myFunction()"` attributes fire but the function was never
registered because the inline script was suppressed.

**Fix:** Move all functions to a proper JS attachment. Bind events via
`addEventListener` in that attachment — never use inline `onclick` attributes.

---

### 4.3 CSP on /web/content — nested iframes can't run scripts
**Symptom:** Animation/script inside an `<iframe src="/web/content/{id}">` is
silently blocked. DevTools shows `default-src 'none'` on the iframe document.
**Cause:** Odoo sets a strict CSP on attachment responses.

**Fix — Blob URL pattern (for content you own and trust):**
```js
const html = await fetch('/web/content/{id}').then(r => r.text());
const blob = new Blob([html], { type: 'text/html' });
iframe.src = URL.createObjectURL(blob);
// Revoke after load: iframe.onload = () => URL.revokeObjectURL(iframe.src);
```
Blob URLs inherit the parent origin — CSP satisfied, scripts run normally.

---

### 4.4 Z-Index — Odoo toolbar covers custom modals
**Symptom:** Custom modal is clipped behind Odoo's website editor toolbar.
**Cause:** Odoo publisher bar is `z-index: 1050`.

**Fix:** Set `.your-modal { z-index: 1100; }` — anything above 1050 wins.

---

### 4.5 iframe sandbox — allow-scripts + allow-same-origin warning
`sandbox="allow-scripts allow-same-origin"` always triggers a browser advisory
(the two flags cancel each other's protection). This is permanent when both are
needed. Accept the advisory or switch to the Blob URL pattern (4.3) which needs
no sandbox at all for trusted content.

---

## 5 — Access Restriction

```python
# Restrict page to a group
update(model="ir.ui.view", id=<view_id>,
       values={"groups_id": [[4, <group_id>]]})

# Find group IDs
search(model="res.groups",
       domain=[["full_name", "ilike", "Website Publisher"]])
```

---

## 6 — Checklist

- [ ] `list_workflows` / `find_skill` called before any multi-step operation
- [ ] All assets uploaded via `fetch_and_upload` (not base64 manually)
- [ ] In-place updates use `attachment_id` param — no new record created
- [ ] No DOM queries for initially-hidden elements at script load time
- [ ] No inline onclick attributes — all events via addEventListener
- [ ] Nested iframe content served via Blob URL if scripts must run inside
- [ ] Custom modals use z-index ≥ 1100
- [ ] `get_page_arch` → compose full arch in memory → single `set_page_arch`
- [ ] `fields` list always specified in read operations (never fetch all)
