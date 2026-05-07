---
name: upload_attachment
summary: Create an ir.attachment record from a local file (binary) or an external URL.
hint: |
  Use for any file that must be stored in Odoo and later referenced by a record
  (cover image, document, media). Always set `public: true` for website-facing assets.
  For Unsplash images use the `fetch_and_upload` tool — Odoo fetches the binary itself
  via its Unsplash integration; no base64 step needed.
applies_to:
  models: ["*"]
  operations: [upload, attach, image]
tools_used: [create, fetch_and_upload, list_attachments]
preconditions:
  - For binary uploads: file must be base64-encoded before passing to `datas`.
  - For URL attachments: the URL must be publicly reachable (Odoo stores the reference, not the binary).
  - For Unsplash: Unsplash API key must be configured in Odoo website settings.
anti_patterns:
  - "Fetching `datas` field via `get_record` or `list_attachments` — it is base64 binary and will flood context instantly. Never request it."
  - "Using `update` on a record's binary field directly (e.g. `blog.post.cover`) without creating an ir.attachment first — cover images must be attachments."
  - "Forgetting `public: true` on website-facing attachments — image will return 403 in the browser."
---

# Skill: Upload an attachment

Three paths depending on source.

## Path A — Binary file (local file, screenshot, generated content)

### Step 1 — Base64-encode the file

Do this outside Odoo (shell or agent runtime):
```bash
base64 -w 0 /path/to/file.jpg
```

### Step 2 — Create the attachment

```
create('ir.attachment', {
  name: 'filename.jpg',
  type: 'binary',
  datas: '<base64 string>',
  mimetype: 'image/jpeg',
  res_model: 'blog.post',   # optional: links attachment to a record
  res_id: <record_id>,       # optional: links attachment to a record
  public: true               # required for website-facing assets
})
```
Returns: `{ id: <attachment_id> }`

Reference in arch or field value: `/web/image/<attachment_id>`

---

## Path B — External URL (no binary stored, reference only)

```
create('ir.attachment', {
  name: 'Image label',
  type: 'url',
  url: 'https://example.com/image.jpg',
  mimetype: 'image/jpeg',
  public: true
})
```

Use when you want Odoo to know about the file without downloading it.
Reference the `url` field directly in arch `src` attributes.

---

## Path C — Unsplash image (preferred for stock photography)

```
fetch_and_upload(query='<search term>', model='blog.post', record_id=<id>)
```

Odoo fetches the Unsplash binary, stores it as a binary attachment, and links it to the record.
Returns the attachment id and `/web/image/<id>` URL ready to use.

---

## Verify

```
list_attachments(res_model='<model>', res_id=<record_id>)
```
Confirm the attachment appears with correct `name`, `mimetype`, and `public` flag.
Do **not** pass `fields=['datas']` — this floods context with base64.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| 403 on `/web/image/<id>` | `public` not set to `true` | `update('ir.attachment', id, {public: true})` |
| Image not displayed in website editor | `res_model`/`res_id` not set, attachment not linked | Re-create with correct `res_model` and `res_id` |
| `datas` field causes context overflow | Requested `datas` in a list or get call | Remove `datas` from fields param; never fetch binary fields |
