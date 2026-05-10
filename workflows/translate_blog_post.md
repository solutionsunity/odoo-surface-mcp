---
name: translate_blog_post
summary: End-to-end translation of a blog.post record (title, subtitle, content) into a target language.
skills: [translate_char_field, translate_html_field]
applies_to:
  models: [blog.post]
  operations: [translate]
preconditions:
  - Target language is installed and active in res.lang (`search_records('res.lang', [['code','=','<lang>'], ['active','=',true]])`).
  - Caller has write access to blog.post (verify via `get_model_actions('blog.post')` if unsure).
---

# Workflow: Translate a `blog.post` record

`blog.post` has three primary translatable text fields with two different `translate=` semantics. This workflow sequences them in the correct order and routes each to its skill.

## Field map

| Field | `translate=` | Skill |
|---|---|---|
| `name` (title) | `True` | `translate_char_field` |
| `subtitle` | `True` | `translate_char_field` |
| `content` (body HTML) | `html_translate` | `translate_html_field` |

### Listing excerpt (`teaser`)

The blog listing page renders the **computed** field `teaser`, defined in `website_blog/models/website_blog.py`:

```python
if blog_post.teaser_manual:
    blog_post.teaser = blog_post.teaser_manual
else:
    blog_post.teaser = text_from_html(blog_post.content, True)[:200] + '...'
```

`teaser_manual` is a plain `Text` field — **not translatable**. Consequences:

- If `teaser_manual` is **set**, every language sees the same source-language excerpt. There is no way to translate it via `translation_update`.
- If `teaser_manual` is **false**, `teaser` auto-derives from `content`, which IS translatable, so each language gets a localized excerpt for free once Step 4 has run.

To get per-language listing excerpts, the post must have `teaser_manual = false`. If a curated excerpt is in `teaser_manual`, decide between (a) clearing it (all languages auto-derive from their translated content) or (b) keeping it (source-language curated excerpt, all other languages mirror it). There is no third option.

```
update('blog.post', id, {'teaser_manual': false})    # clear so listing excerpt localizes
```

## Procedure

### Step 1 — Inspect the record

```
get_record('blog.post', record_id, fields=['name', 'subtitle', 'teaser_manual', 'website_url', 'seo_name'])
```
Capture source-language values. Skip `content` here — it is large; the skill reads only the registered terms via `translation_get`. Note `teaser_manual` for the Step 3 decision.

**URL slug guard — run before translating anything:**
`seo_name` is not translatable; it anchors the URL slug for every language. If it is `false`,
non-ASCII languages (Arabic, CJK, etc.) will produce a bare numeric ID as the URL.

```
# if seo_name is false:
# derive slug from the source-language website_url
# website_url = "/blog/ai-4/why-your-ai-strategy-is-failing-2"
# slug segment = last path component stripped of trailing "-{id}"  → "why-your-ai-strategy-is-failing"
update('blog.post', record_id, {'seo_name': '<derived-slug>'})
```
Verify: re-read `website_url` and confirm it ends with `<seo_name>-<id>`.
Only proceed to Step 2 once `seo_name` is confirmed set.

### Step 2 — Translate `name` and `subtitle`

Apply skill `translate_char_field` once per field:
1. `translation_get('blog.post', id, 'name', langs=['<lang>'])` to confirm source.
2. Translate the string.
3. `translation_update('blog.post', id, 'name', translations={'<lang>': '<translated>'})`.
4. Repeat for `subtitle`.

You may batch both fields in a single mental pass — but the API requires one `translation_update` call per field (the call is field-scoped).

### Step 3 — Decide listing-excerpt strategy

If `teaser_manual` is set and a per-language listing excerpt is required, clear it via `update('blog.post', id, {'teaser_manual': false})` **only with explicit user confirmation** (this is a destructive change to the source-language record, not a translation). Otherwise leave it.

### Step 4 — Translate `content`

Apply skill `translate_html_field`:
1. `translation_get('blog.post', id, 'content', langs=['<lang>'])` → returns N text-node terms.
2. Save to `tmp/blog_post_<id>_content_<lang>.json` with `_meta` block.
3. Fill every `value` in the JSON. Preserve inline tags exactly. Keep technical proper nouns (`LLM`, `MCP`, `AI Agent`) untranslated when convention requires.
4. Build the translation map using the **key selection rule** from skill `translate_html_field`:
   - Term `value` is empty → key = `source` (arch has English text).
   - Term `value` is non-empty → key = current `value` (arch has existing translation).
5. `translation_update('blog.post', id, 'content', translations={'<lang>': { key_1: new_value_1, ... }})` — single call, all terms.

### Step 5 — Translate SEO meta (if set on source)

SEO meta fields are `translate=True` — each language needs its own values. Check if they are set:
```
get_record('blog.post', id, fields=['website_meta_title', 'website_meta_description', 'website_meta_keywords'])
```
If set on source, apply `translate_char_field` per field, or write directly:
```
update('blog.post', id,
  { website_meta_title: '<translated title>',
    website_meta_description: '<translated description>',
    website_meta_keywords: '<translated keywords>' },
  context={'lang': '<lang>'}
)
```

### Step 6 — Verify

```
translation_get('blog.post', id, 'name',     langs=['<lang>'])
translation_get('blog.post', id, 'subtitle', langs=['<lang>'])
translation_get('blog.post', id, 'content',  langs=['<lang>'])
get_record('blog.post', id, fields=['teaser', 'teaser_manual', 'website_url', 'website_meta_title'], context={'lang': '<lang>'})
```
- `name`, `subtitle`: each returns one entry; `value` must be non-empty and match what you pushed.
- `content`: every entry must have non-empty `value`. Empty entries indicate source-key mismatch — re-extract and retry only the affected terms.
- `teaser` in target-lang context: must render in the target language. If still source-language, `teaser_manual` is set — revisit Step 3.
- `website_url`: must be identical to the source-language URL (same `seo_name`-derived slug). If it shows a bare ID, the URL guard in Step 1 was missed — run it now.

### Step 7 — Visual check (optional but recommended)

Visit `/<lang_short>/blog/<blog_slug>/<post_slug>` (e.g. `/ar/blog/ai-4/why-your-ai-strategy-is-failing-its-not-the-llm-its-the-architecture-2`) to confirm the translated page renders. RTL languages should render right-to-left automatically if the language record's `direction` is `rtl`.

## Out of scope (handle separately)

- **Cover image / `cover_properties`**: not text — no translation needed.
- **Tags (`tag_ids`)**: tag names are translatable on `blog.tag`; if you need translated tag names, run `translate_char_field` on each tag's `name` field.
- **Comments**: user-generated, not part of post translation.
- **SEO meta** (`website_meta_title`, `website_meta_description`, `website_meta_keywords`): all `translate=True` chars. If the post has them set and you need them translated, apply `translate_char_field` per field as a follow-up.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Translated page shows mixed languages | Some fields skipped or `content` had partial term coverage | Re-run Step 6 verification; identify empty entries; re-translate only those |
| Blog listing excerpt stays in source language | `teaser_manual` is set (not translatable) so all languages share its value | Confirm with user, then `update('blog.post', id, {'teaser_manual': false})` to make `teaser` auto-derive per-language from translated `content` |
| 404 on `/<lang>/blog/...` URL | Language not published on website, or website language list excludes target | Add the language to `website.language_ids` (publish it on the website) |
| RTL not applied | `res.lang.direction` not set to `rtl` for the language | Update `res.lang` record: `update('res.lang', id, {direction: 'rtl'})` |
| Non-ASCII URL is a bare numeric ID (`/blog/ai-4/7`) | `seo_name` not set; `slug()` converts non-ASCII title to empty string and falls back to `str(id)` | Run Step 1 URL slug guard: derive slug from source-lang `website_url`, set via `update('blog.post', id, {'seo_name': '<slug>'})` |
| URL differs between languages | `seo_name` not set at creation; each language slugifies its own translated title | Same fix as above — `seo_name` is language-agnostic and unifies the URL across all locales |
