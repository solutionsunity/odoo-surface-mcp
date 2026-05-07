---
name: translate_char_field
summary: Single-string translation of a char/text field via translation_update.
hint: |
  Use standalone for any translatable char/text field (e.g. `name`, `subtitle`,
  `description_short`). For multi-field jobs on the same record, prefer a
  workflow that batches all field updates together.
applies_to:
  field_types: [char, text]
  models: ["*"]
  operations: [translate]
tools_used: [get_fields, translation_get, translation_update]
preconditions:
  - Target language is installed in res.lang and active.
  - Field is translatable (translate=True verified via get_fields or model source).
anti_patterns:
  - "Using the map form `{source: value}` for char fields (designed for HTML fields)."
  - "Updating the source-language value via `update` and expecting translations to follow (they don't — translations are stored separately keyed by lang)."
---

# Skill: Translate a char/text field (`translate=True`)

For char and text fields with `translate=True`, Odoo registers exactly **one term per language**: the full field value. There is no DOM walking and no per-node splitting.

This means:
- The translation is the entire target-language string.
- `translation_update` takes a plain string (not a map) for the language.

## Procedure

### Step 1 — Verify translatability

```
get_fields(model)
```
Confirm the field's `translate` attribute is `true`. If `false` or `"html_translate"`, this skill does not apply (use `translate_html_field` for the latter).

### Step 2 — (Optional) Read existing translation

```
translation_get(model, record_id, field_name, langs=["<lang>"])
```
Returns:
```json
{ "translations": [
  { "lang": "ar_001", "source": "<current source-language value>", "value": "<existing translation or empty>" }
] }
```
Useful to confirm the source value and check if a translation already exists before overwriting.

### Step 3 — Push the translation

```
translation_update(
  model, record_id, field_name,
  translations={ "<lang>": "<translated string>" }
)
```
- Use the **string** form for char/text fields. The map form is for HTML fields and may silently no-op.
- Multiple languages in one call: `{ "ar_001": "...", "fr_FR": "...", "es_ES": "..." }`.

### Step 4 — Verify

```
translation_get(model, record_id, field_name, langs=["<lang>"])
```
The `value` for the requested language must equal the string you pushed.

## Notes

- **Source vs translation are independent.** Updating the field via `update(model, record_id, {field: "..."})` changes the source-language value but does NOT touch other languages. If you change the English title, the Arabic title is still the previous Arabic translation — review it and re-translate if semantics shifted.
- **Default lang of the record.** The "source" returned by `translation_get` is the value in the record's source language (usually `en_US` for the install). If you need a different reference language, pass it in `langs`.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `translation_update` returns success, frontend still shows source string | Used map form `{source: value}` instead of plain string | Re-call with string form: `{"<lang>": "<string>"}` |
| New translation appears but old one comes back later | Someone called `update` on the field in source language, which can re-trigger seed translations on some setups | Re-push the translation after any source-language update |
| Language code not recognized | Used short code (`ar`) instead of locale (`ar_001`, `ar_SA`) | Look up the exact installed code in `res.lang` |
