---
name: upload_attachment
summary: Create or replace an ir.attachment record from a local file (binary) or an external URL.
hint: |
  Use for any file that must be stored in Odoo and later referenced by a record
  (cover image, document, media). Always set `public: true` for website-facing assets.
  To update an existing attachment in-place, pass `attachment_id` — the ID stays the same,
  no arch or reference updates needed. For Unsplash images use the `fetch_and_upload` tool —
  Odoo fetches the binary itself via its Unsplash integration; no base64 step needed.
applies_to:
  models: ["*"]
  operations: [upload, attach, image, replace, update]
tools_used: [create, fetch_and_upload, list_attachments]
preconditions:
  - For binary uploads: file must be base64-encoded before passing to `datas`.
  - For URL attachments: the URL must be publicly reachable (Odoo stores the reference, not the binary).
  - For Unsplash: Unsplash API key must be configured in Odoo website settings.
anti_patterns:
  - "Fetching `datas` field via `get_record` or `list_attachments` — it is base64 binary and will flood context instantly. Never request it."
  - "Using `update` on a record's binary field directly (e.g. `blog.post.cover`) without creating an ir.attachment first — cover images must be attachments."
  - "Forgetting `public: true` on website-facing attachments — image will return 403 in the browser."
  - "Creating a new attachment to replace an existing one — use attachment_id to update in-place and keep the same ID."
---

# Skill: Upload an attachment

Three paths depending on source.

## Path A — Local file, new attachment (preferred for any file on disk)

Use `fetch_and_upload` — MCP server reads and transfers the file directly. No base64 in agent context.

```
fetch_and_upload(
  source='/absolute/path/to/file.jpg',
  name='filename.jpg',
  is_image=false,   # true for images, false for JS/CSS/HTML/JSON
  public=true
)
```
Returns: `{ id: <attachment_id>, src: '/web/content/<id>' }`

Reference images via `/web/image/<id>`, all other assets via `/web/content/<id>`.

---

## Path A2 — Local file, replace existing attachment in-place

When a file has already been uploaded and is referenced in arch or code by its ID,
use `attachment_id` to overwrite the binary without changing the ID.
**No arch or reference update needed after this call.**

```
fetch_and_upload(
  source='/absolute/path/to/updated-file.js',
  attachment_id=<existing_id>,
  is_image=false,
  public=true
)
```
Returns: `{ id: <same_id>, src: '/web/content/<same_id>' }`

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
| Arch references break after update | Created a new attachment instead of replacing | Use `attachment_id` param to replace in-place; ID stays the same |
