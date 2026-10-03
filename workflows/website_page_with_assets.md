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
- Overwrites the attachment's content on the same record (any Odoo version). URL `/web/content/{id}` stays valid.
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
<t t-name="{key from the arch get_page_arch returned}">
  <t t-set="head">
    <link rel="stylesheet" type="text/css" href="/web/content/{css_id}"/>
    <script type="text/javascript">
      /* Inline theme-flash only — kept tiny */
      (function(){try{var s=localStorage.getItem('theme');
        document.documentElement.setAttribute('data-theme',s||'light');
      }catch(e){}}());
    </script>
    <script type="text/javascript" src="/web/content/{js_id}"/>
  </t>
  <t t-call="website.layout" head="head">
    <div id="app-root" data-manifest-id="{manifest_attachment_id}">
      <!-- static shell; JS renders into this -->
    </div>
  </t>
</t>
```

- Create the page with `create_page`, then `get_page_arch` → edit in memory → `set_page_arch` (one write).
- Set `head` **before** the `t-call` and pass it (`head="head"`): Odoo 20 no longer lets a `t-set` inside
  the `t-call` body reach the layout. This form works on Odoo 15–20.
- `website.page` is metadata only; content lives on `ir.ui.view.arch_db`.

---

## 4 — Known Gotchas (from UAC Atlas)

Browser-side field notes from production. 4.2's cause and 4.3 are verified against Odoo 15–20; the
others are observations.

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
**Cause:** not an Odoo policy — Odoo sends no Content-Security-Policy on website pages (verified
15.0–20.0). When inline scripts are suppressed, the policy comes from elsewhere (reverse proxy, CDN) or
the content went through the editor's sanitizer. Inline `onclick="myFunction()"` then fires against a
function that was never registered.

**Fix:** Move all functions to a proper JS attachment. Bind events via
`addEventListener` in that attachment — never use inline `onclick` attributes.

---

### 4.3 CSP on /web/content — nested iframes can't run scripts
**Symptom:** Animation/script inside an `<iframe src="/web/content/{id}">` is
silently blocked. DevTools shows `default-src 'none'` on the iframe document.
**Cause:** Odoo serves HTML attachments with `Content-Security-Policy: default-src 'none'` (verified 15.0–20.0).

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
# Find the group (by its name, e.g. "Restricted Editor", or any group you created)
list_records(model="res.groups",
             domain=[["full_name", "ilike", "<group name>"]], fields=["full_name"])

# Restrict the page: visibility AND the group — groups alone restrict nothing.
# The field is groups_id up to Odoo 18, group_ids from Odoo 19.
update(model="website.page", record_id=<page_id>,
       values={"visibility": "restricted_group", "groups_id": [[4, <group_id>]]})
```
Other `visibility` values: `""` (all), `"connected"` (signed-in users), `"password"`.

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
