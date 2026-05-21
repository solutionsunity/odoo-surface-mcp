---
name: upload_asset
summary: Upload static website assets (JS, CSS, HTML, JSON) as public ir.attachment records using fetch_and_upload.
hint: |
  Use for any non-image file that must be served from Odoo via /web/content/{id}.
  Covers JS, CSS, HTML fragments, JSON manifests, fonts, SVGs.
  fetch_and_upload handles the file read and transfer — no base64, no shell encoding.
  Always set public: true and is_image: false.
applies_to:
  models: ["ir.attachment"]
  operations: [upload, attach, website, asset]
tools_used: [fetch_and_upload]
preconditions:
  - File must exist at an absolute path accessible to the MCP server.
  - For website-facing assets: public must be true.
anti_patterns:
  - "Base64-encoding files manually — fetch_and_upload makes this obsolete for local files."
  - "Passing is_image: true for JS/CSS/HTML/JSON — it changes the served URL to /web/image which may not work for non-image MIME types."
  - "Fetching `datas` field after upload — it is base64 binary and will flood context instantly."
  - "Using /web/image/{id} for JS/CSS/HTML assets — use /web/content/{id} instead."
---

# Skill: Upload static website assets

## Single asset

```
fetch_and_upload(
  source='/absolute/path/to/learn.js',
  name='learn.js',
  is_image=false,
  public=true
)
```
Returns: `{ id: 1234, src: '/web/content/1234' }`

Use the returned `id` to build the script/link tag inside `arch_db`:
```html
<script type="text/javascript" src="/web/content/1234"/>
<link rel="stylesheet" href="/web/content/5678"/>
```

## Batch upload (multiple assets)

Call `fetch_and_upload` once per file. Collect all returned IDs before writing any arch.
Do not interleave uploads with arch edits — finish all uploads first.

```
# JS assets
fetch_and_upload(source='/path/learn.js',   name='learn.js',   is_image=false, public=true)  → id: 1001
fetch_and_upload(source='/path/library.js', name='library.js', is_image=false, public=true)  → id: 1002
fetch_and_upload(source='/path/upload.js',  name='upload.js',  is_image=false, public=true)  → id: 1003

# CSS assets
fetch_and_upload(source='/path/atlas.css',  name='atlas.css',  is_image=false, public=true)  → id: 2001

# HTML fragments / JSON
fetch_and_upload(source='/path/letter.html', name='noon--full-stroke.html', is_image=false, public=true)  → id: 3001
fetch_and_upload(source='/path/manifest.json', name='manifest.json',        is_image=false, public=true)  → id: 4001
```

## JSON manifest (dynamic content)

When manifest content must be built from upload results (e.g. contains attachment IDs), write the file to a temp path first, then upload:

```bash
# Build manifest with real IDs, write to /tmp/manifest.json
echo '{"letters": [...]}' > /tmp/manifest.json
```
```
fetch_and_upload(source='/tmp/manifest.json', name='manifest.json', is_image=false, public=true)
```

## URL reference in arch_db

Assets served from Odoo use `/web/content/{id}` (not `/web/image/{id}`):
```html
<script type="text/javascript" src="/web/content/{js_id}"/>
<link rel="stylesheet" type="text/css" href="/web/content/{css_id}"/>
```

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| 403 on `/web/content/{id}` | `public` not set | `update('ir.attachment', id, {public: true})` |
| File not found error | Relative path used | Use absolute path only |
| Wrong MIME served | `is_image=true` on non-image | Re-upload with `is_image=false` |
