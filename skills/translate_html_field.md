---
name: translate_html_field
summary: Term-by-term translation of an HTML field via translation_get → translation_update.
hint: |
  Use standalone for ad-hoc translation of one HTML field on any model.
  For translating a full blog post (title + subtitle + content + cover), prefer
  workflow `translate_blog_post` — it sequences the field-type variants correctly.
applies_to:
  field_types: [html_translate]
  models: ["*"]
  operations: [translate]
tools_used: [get_fields, translation_get, translation_update]
preconditions:
  - Target language is installed in res.lang and active.
  - Field is translatable (translate=html_translate verified via get_fields or model source).
anti_patterns:
  - Passing the entire HTML blob as a single source key (silent no-op).
  - Translating source strings guessed from the rendered page (whitespace, entities, inline tags drift).
  - Looping translation_update once per term (works but wasteful — batch in one call).
---

# Skill: Translate an HTML field (`translate=html_translate`)

Odoo's `html_translate` callable walks the DOM at save time and registers **one term per text node**. Inline tags (`<strong>`, `<i>`, `<a>`) are kept **inside** the parent text node — a paragraph with bold words is one term, not three. The full HTML blob is **never** registered as a single term.

This means:
- You cannot translate by sending the rendered HTML back as a key.
- You must read the registered source terms verbatim, then push translations keyed on those exact strings.

## Procedure

### Step 1 — Verify translatability (optional but cheap)

```
get_fields(model)
```
Confirm `<field>.translate` is `"html_translate"` (or callable). If `false`, this skill does not apply.

### Step 2 — Extract registered terms

```
translation_get(model, record_id, field_name, langs=["<lang>"])
```
Returns one entry per registered text node:
```json
{ "translations": [
  { "lang": "ar_001", "source": "<exact registered string>", "value": "<existing translation or empty>" }
] }
```

### Step 3 — Persist to a working file (recommended)

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
- `source` — **never modify**. It is the lookup key Odoo uses internally.
- `value` — fill in the translation. Leave empty to skip that term.

### Step 4 — Translate each `value`

- Preserve inline tags exactly (`<strong>…</strong>` stays `<strong>…</strong>` in target language).
- Preserve `&` entities, smart quotes, and surrounding whitespace if present in source.
- Keep technical proper nouns untranslated when convention requires (e.g. `LLM`, `MCP`, brand names).

### Step 5 — Push all terms in a single call

```
translation_update(
  model, record_id, field_name,
  translations={ "<lang>": { "<source_1>": "<value_1>", "<source_2>": "<value_2>", ... } }
)
```
- Use the **map** form (`{ source: value }`) for HTML fields. The string form is for char/text fields and will silently no-op here.
- Send all non-empty terms in one call. No need to loop.
- Empty `value` entries: omit them from the map (don't push empty strings — they overwrite existing translations with empty).

### Step 6 — Verify

```
translation_get(model, record_id, field_name, langs=["<lang>"])
```
Every `source` you pushed must now have a non-empty `value`. Any remaining empties indicate:
- Source-key mismatch (you modified the `source` field).
- Language not installed.
- Field-type assumption wrong (re-check `get_fields`).

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `translation_update` returns `success: true`, frontend still shows source language | Passed full HTML blob as single key, or passed string instead of map | Re-extract via `translation_get`; use map form keyed on exact source strings |
| Some terms translated, others not | Source strings were modified during editing | Restore `source` from a fresh `translation_get` |
| All terms translated but page still original language | Language not installed/active in res.lang, or wrong lang code (use `ar_001` not `ar`) | Verify with `search_records('res.lang', [['code','=','<lang>']])` |
