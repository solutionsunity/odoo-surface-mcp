---
name: upload_attachment
summary: Create or replace an ir.attachment record from a local file (binary) or an external URL.
hint: |
  Use for any file that must be stored in Odoo and later referenced by a record
  (cover image, document, media). Always set `public: true` for website-facing assets.
  To update an existing attachment in-place, pass `attachment_id` — the ID stays the same,
  no arch or reference updates needed. Remote files (any URL, e.g. an Unsplash image URL) go
  through `fetch_and_upload` too — the MCP server downloads them; no base64 in context.
applies_to:
  models: ["*"]
  operations: [upload, attach, image, replace, update]
tools_used: [create, fetch_and_upload, list_attachments]
preconditions:
  - "Local files need an absolute path readable by the MCP server; remote files a URL the MCP server can reach."
  - "For URL-reference attachments (Path B) the URL must be publicly reachable — Odoo stores the reference, not the binary."
anti_patterns:
  - "Reading an attachment's content field (`datas`; `raw` on Odoo 20) via `get_record` or `list_records` — it is base64 and floods context instantly. Use `download_binary` to get the bytes onto disk."
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

## Path C — Remote file (stock photography, any URL)

```
fetch_and_upload(
  source='https://images.unsplash.com/photo-…?w=1600',
  name='cover.jpg',
  is_image=true,
  public=true,
  res_model='blog.post', res_id=<id>   # optional: link to a record
)
```

The MCP server downloads the file and stores it as a binary attachment. Pick the image URL yourself
(e.g. from Unsplash); there is no search integration. Returns `{ id, src }` with `/web/image/<id>`.

---

## Verify

```
list_attachments(res_model='<model>', res_id=<record_id>)
```
Confirm the attachment appears with correct `name`, `mimetype`, and `public` flag.
Never request the content field (`datas`; `raw` on Odoo 20) — it floods context with base64.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| 403 on `/web/image/<id>` | `public` not set to `true` | `update('ir.attachment', id, {public: true})` |
| Image not displayed in website editor | `res_model`/`res_id` not set, attachment not linked | Re-create with correct `res_model` and `res_id` |
| Context overflow after a read | Requested the content field (`datas` / `raw`) in a list or get call | Never fetch binary fields; use `download_binary` |
| Arch references break after update | Created a new attachment instead of replacing | Use `attachment_id` param to replace in-place; ID stays the same |
