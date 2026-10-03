---
name: translate_html_field
summary: Term-by-term translation of an HTML field via translation_get → translation_update.
hint: |
  Use standalone for ad-hoc translation of one HTML field on any model.
  For translating a full blog post (title + subtitle + content + cover), prefer
  workflow `translate_blog_post` — it sequences the field-type variants correctly.
applies_to:
  field_types: [html_translate, xml_translate]
  models: ["*"]
  operations: [translate]
tools_used: [translation_get, translation_update, translation_audit]
preconditions:
  - Target language is installed in res.lang and active.
  - "Field is term-translated — `translation_get` reports `translation_show_source: true`."
anti_patterns:
  - Passing the entire HTML blob as a single source key (silent no-op).
  - Translating source strings guessed from the rendered page (whitespace, entities, inline tags drift).
  - Looping translation_update once per term (works but wasteful — batch in one call).
  - >-
    Writing the translation with update + context={'lang': <target>} on a translatable HTML field — this
    overwrites the SOURCE with the translation, destroying the base-language body and making the source
    terms the wrong language for every reader. Always use translation_update. Detect the damage with
    translation_audit (suspect_source flag).
---

# Skill: Translate an HTML field (`translate=html_translate`)

This skill covers both `html_translate` and `xml_translate` fields. `xml_translate` is used by `ir.ui.view.arch_db` (QWeb views, website pages). Both callables walk the DOM/XML at save time and register **one term per text node** — the procedure is identical for both.

> **`xml_translate` note:** `arch_db` lives on `ir.ui.view`, not on `website.page` directly. Reach it via the page's `view_id` field. All steps below apply unchanged.

---

Odoo's `html_translate` callable walks the DOM at save time and registers **one term per text node**. Inline tags (`<strong>`, `<i>`, `<a>`) are kept **inside** the parent text node — a paragraph with bold words is one term, not three. The full HTML blob is **never** registered as a single term.

This means:
- You cannot translate by sending the rendered HTML back as a key.
- You must read the registered source terms verbatim, then push translations keyed on those exact strings.

## Procedure

### Step 1 — Extract registered terms

```
translation_get(model, record_id, field_name, langs=["<lang>"])
```
`translation_show_source: true` confirms a term-translated (html/xml) field; `false` means a whole-value
field — use `translate_char_field`; no entries means the field is not translatable. Returns one entry per
registered text node:
```json
{ "translations": [
  { "lang": "ar_001", "source": "<exact registered string>", "value": "<existing translation or empty>" }
] }
```

### Step 2 — Persist to a working file (recommended)

Save the response to `tmp/<model>_<id>_<field>.json` shaped as:
```json
{
  "_meta": {
    "model": "blog.post", "record_id": 2, "field_name": "content",
    "lang": "ar_001", "field_translate": "html_translate", "term_count": 38
  },
  "terms": [
    { "source": "<exact string Odoo returned>", "value": "" }
  ]
}
```
- `source` — **never modify**. Human-readable reference only.
- `value` — fill in the translation. Leave empty to skip that term.

### Step 3 — Translate each `value`

- Preserve inline tags exactly (`<strong>…</strong>` stays `<strong>…</strong>` in target language).
- Preserve `&` entities, smart quotes, and surrounding whitespace if present in source.
- Keep technical proper nouns untranslated when convention requires (e.g. `LLM`, `MCP`, brand names).

### Step 4 — Push all terms in a single call

```
translation_update(
  model, record_id, field_name,
  translations={ "<lang>": { "<source_1>": "<value_1>", "<source_2>": "<value_2>", ... } }
)
```
- Use the **map** form for HTML fields. The string form is for char/text fields and will silently no-op here.
- Send all non-empty terms in one call. No need to loop.
- Empty `value` entries: omit them from the map (don't push empty strings — they overwrite existing translations with empty).
- Translating several records (or `name` + `html_content` together)? Use the batch form to do it in one call:
  `translation_update(model, updates=[{record_id, field_name, translations}, ...])`.

> **Keys are the `source` terms** exactly as `translation_get` returned them — for new and already
> translated terms alike, on every Odoo version (the surface maps them to what the server expects).
> Odoo 15.0: source (`en_US`) terms cannot be rewritten term by term — write the field itself with `update` and `context={'lang': 'en_US'}`.

### Step 5 — Verify

Prefer `translation_audit` — it checks coverage and source integrity in one call, and accepts arrays so
you can verify many records/fields at once:

```
translation_audit(model, record_id, field_name, target_langs=["<lang>"])
```
Read the result:
- `passed: true` and `summary.total_missing == 0` → every term is translated.
- `results[].langs.<lang>.missing` → exact source terms still untranslated (re-push those keys).
- `results[].suspect_source` (non-empty) → the SOURCE terms are in the target script: the base-language
  body was overwritten (almost always by `update` + `context:{lang}`). Re-push the base-language source
  via `update` with `context={'lang': 'en_US'}`, then re-apply translations with `translation_update`.

Or, for a single field, the raw read still works:
```
translation_get(model, record_id, field_name, langs=["<lang>"])
```
Every `source` you pushed must now have a non-empty `value`. Any remaining empties indicate:
- Source-key mismatch (you modified the `source` field).
- Language not installed.
- Field-type assumption wrong (re-check `translation_show_source`).

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `translation_update` returns `success: true`, frontend still shows source language | Passed full HTML blob as single key, or passed string instead of map | Re-extract via `translation_get`; use the map form keyed by `source` |
| Some terms translated, others not | Keys modified or guessed instead of copied from `source` | Re-extract via `translation_get`; key every term by its verbatim `source` |
| All terms translated but page still original language | Language not installed/active in res.lang, or wrong lang code (use `ar_001` not `ar`) | Verify with `list_records('res.lang', domain=[['code','=','<lang>']], fields=['code','active'])` |
