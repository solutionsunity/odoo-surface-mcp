---
name: migrate_binary_field
summary: Copy a binary field value from a record on one Odoo instance to a record on another, using the local filesystem as a zero-context buffer.
hint: |
  Use whenever a binary field (image, QR code, PDF, document) must be migrated
  between two Odoo instances without base64 flooding the AI context.
  The pattern: download_binary on source MCP → upload_binary on target MCP.
  Both tools operate on absolute filesystem paths shared between the two MCP server processes.
applies_to:
  models: ["*"]
  operations: [migrate, copy, transfer, binary, image, document, upload, download]
tools_used: [download_binary, upload_binary, list_attachments, search_records]
preconditions:
  - Both MCP servers must share filesystem access to the temp path (e.g. /tmp).
  - The source record and target record must already exist.
  - The field must be a binary (base64) field — not a Many2one to ir.attachment.
  - The target record must be writable (correct state, correct ACL).
anti_patterns:
  - "Calling get_record with a binary field name — datas / image_1920 / photo will return a base64 blob and flood the AI context."
  - "Using fetch_and_upload for cross-instance binary migration — it fetches from HTTP URLs, not Odoo ORM binary fields."
  - "Choosing a relative path for dest_path / source_path — always use an absolute path (e.g. /tmp/...)."
  - "Reusing the same temp path for multiple binaries in parallel — use unique filenames per field/record."
---

# Skill: Migrate a binary field between two Odoo instances

## Standard pipe (source MCP → shared disk → target MCP)

### Step 1 — Download from source
Call `download_binary` on the **source** MCP. Choose a unique absolute temp path.

```
download_binary(
  model='realestate.valuation.line',
  record_id=13,
  field='qima_qr_code',
  dest_path='/tmp/migration/vl13_qima_qr.png'
)
```
Returns: `{ success: true, dest_path: '/tmp/migration/vl13_qima_qr.png', size_bytes: 4821 }`

### Step 2 — Upload to target
Call `upload_binary` on the **target** MCP using the same path.

```
upload_binary(
  model='realestate.valuation.line',
  record_id=2,
  field='qima_qr_code',
  source_path='/tmp/migration/vl13_qima_qr.png'
)
```
Returns: `{ success: true, model: 'realestate.valuation.line', record_id: 2, field: 'qima_qr_code', size_bytes: 4821 }`

---

## Batch migration pattern

For multiple binaries, loop through (model, src_id, dst_id, field) tuples.
Use a predictable naming scheme to avoid collisions:

```
/tmp/migration/<model_slug>_<src_id>_<field>.bin
```

Example batch for inspection photos:

```
# For each photo record (src_id → dst_id mapping from id_mappings.json):
download_binary(model='realestate.valuation.inspection.photo', record_id=<src_id>, field='photo', dest_path='/tmp/migration/photo_<src_id>.jpg')
upload_binary(  model='realestate.valuation.inspection.photo', record_id=<dst_id>, field='photo', source_path='/tmp/migration/photo_<src_id>.jpg')
```

---

## Locating binary fields via ir.attachment

Some binary fields are stored as standalone `ir.attachment` rows (res_field set).
Use `list_attachments` first to discover them:

```
list_attachments(res_model='realestate.valuation.inspection.photo', res_id=<src_id>)
```

If `res_field` is set, the binary lives on the record's ORM field → use `download_binary` / `upload_binary`.
If no `res_field` entry, the binary IS the `ir.attachment.datas` field itself →
migrate the attachment record separately using `download_binary(model='ir.attachment', ...)`.

---

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `error: Field '...' is empty or not a binary` | Field has no value on source | Skip; log as "no binary to migrate" |
| `error: ENOENT: no such file or directory` on upload | download step was skipped or path mismatch | Re-run download step first |
| `error: No writable fields found` | Record is in a locked state | Reopen record, upload, re-complete |
| `error: Odoo authentication failed` | Wrong env vars for that MCP instance | Check ODOO_URL / ODOO_DB / ODOO_PASSWORD |
| `size_bytes` differs between download and upload | Should never happen (round-trip is lossless) | Verify dest_path and source_path are identical |
