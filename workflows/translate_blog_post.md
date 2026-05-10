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
get_record('blog.post', record_id, fields=['name', 'subtitle', 'teaser_manual', 'website_url'])
```
Capture source-language values. Skip `content` here — it is large; the skill reads only the registered terms via `translation_get`. Note `teaser_manual` for the Step 3 decision.

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

### Step 5 — Verify

```
translation_get('blog.post', id, 'name',     langs=['<lang>'])
translation_get('blog.post', id, 'subtitle', langs=['<lang>'])
translation_get('blog.post', id, 'content',  langs=['<lang>'])
get_record('blog.post', id, fields=['teaser', 'teaser_manual'], context={'lang': '<lang>'})
```
- `name`, `subtitle`: each returns one entry; `value` must be non-empty and match what you pushed.
- `content`: every entry must have non-empty `value`. Empty entries indicate source-key mismatch — re-extract and retry only the affected terms.
- `teaser` in target-lang context: must render in the target language. If still source-language, `teaser_manual` is set — revisit Step 3.

### Step 6 — Visual check (optional but recommended)

Visit `/<lang_short>/blog/<blog_slug>/<post_slug>` (e.g. `/ar/blog/ai/why-your-ai-strategy-is-failing-2`) to confirm the translated page renders. RTL languages should render right-to-left automatically if the language record's `direction` is `rtl`.

## Out of scope (handle separately)

- **Cover image / `cover_properties`**: not text — no translation needed.
- **Tags (`tag_ids`)**: tag names are translatable on `blog.tag`; if you need translated tag names, run `translate_char_field` on each tag's `name` field.
- **Comments**: user-generated, not part of post translation.
- **SEO meta** (`website_meta_title`, `website_meta_description`, `website_meta_keywords`): all `translate=True` chars. If the post has them set and you need them translated, apply `translate_char_field` per field as a follow-up.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Translated page shows mixed languages | Some fields skipped or `content` had partial term coverage | Re-run Step 5 verification; identify empty entries; re-translate only those |
| Blog listing excerpt stays in source language | `teaser_manual` is set (not translatable) so all languages share its value | Confirm with user, then `update('blog.post', id, {'teaser_manual': false})` to make `teaser` auto-derive per-language from translated `content` |
| 404 on `/<lang>/blog/...` URL | Language not published on website, or website language list excludes target | Add the language to `website.language_ids` (publish it on the website) |
| RTL not applied | `res.lang.direction` not set to `rtl` for the language | Update `res.lang` record: `update('res.lang', id, {direction: 'rtl'})` |
