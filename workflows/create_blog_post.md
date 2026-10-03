---
name: create_blog_post
summary: Create a blog.post record in the source language — title, subtitle, cover image, and structured body content.
skills: [upload_attachment, inject_snippet]
applies_to:
  models: [blog.post, blog.blog, blog.tag]
  operations: [create]
preconditions:
  - A `blog.blog` record exists to attach the post to (`list_records('blog.blog', fields=['name'])` to list).
  - Post is created in the source language (usually `en_US`). For multilingual publishing, run `translate_blog_post` after editorial review.
---

# Workflow: Create a `blog.post` record

Source-language only. Translation is a separate lifecycle step — see `translate_blog_post`.

## Step 1 — Resolve blog id

```
list_records('blog.blog', fields=['name'])
```
Capture the target `blog.blog` id. If no blog exists, create one: `create('blog.blog', {name: 'My Blog'})`.

## Step 2 — Create the post skeleton

Derive `seo_name` from the source-language title before calling `create`:
apply `slugify_one` rules — lowercase, replace non-alphanumeric characters with spaces,
collapse to single hyphens, strip leading/trailing hyphens.
Example: `"MCP: The USB-C for AI"` → `"mcp-the-usb-c-for-ai"`.

`seo_name` is **not translatable** — it is shared across all languages and becomes the URL slug
for every locale. Setting it at creation time prevents Arabic (and any non-ASCII) translations
from falling back to a bare numeric ID in the URL.

```
create('blog.post', {
  blog_id: <blog_id>,
  name: '<Post Title>',
  subtitle: '<Post Subtitle>',
  seo_name: '<slugified-source-title>',   # anchors URL slug for all languages
  website_published: false,               # keep unpublished until content is ready
  is_published: false
})
```
Returns: `{ id: <post_id> }`

Verify the slug was applied:
```
get_record('blog.post', <post_id>, fields=['website_url', 'seo_name'])
```
`website_url` must end with `<seo_name>-<id>`, not just `<id>`.

## Step 3 — Upload cover image

Apply skill `upload_attachment`:

**Option A — Remote image (e.g. an Unsplash photo URL) or local file:**
```
fetch_and_upload(source='<https://… or /absolute/path.jpg>', name='cover.jpg',
                 is_image=true, public=true, res_model='blog.post', res_id=<post_id>)
```
Capture the returned attachment id and `/web/image/<id>` URL. No base64 passes through context.

**Option B — External URL (reference only, not stored):**
```
create('ir.attachment', {name: 'cover', type: 'url', url: '<url>', public: true,
  res_model: 'blog.post', res_id: <post_id>})
```

Set cover on the post:
```
update('blog.post', <post_id>, {
  cover_properties: '{"background-image": "url(/web/image/<attachment_id>)", "background-color": "rgba(0,0,0,.5)", "opacity": "0.6", "resize_class": "o_half_screen_height"}'
})
```

## Step 4 — Build body content

The body is the post's own `content` field (HTML) — not a website page view.

1. `list_snippets()` — identify relevant snippet(s) (e.g. `s_text_image`, `s_text_block`, `s_three_columns`).
2. `get_snippet(key='website.<snippet_name>')` — fetch canonical HTML for each.
3. Compose the body in memory: snippet blocks in order, outer wrappers preserved, editable placeholders filled.
4. Write once: `update('blog.post', <post_id>, {content: '<composed HTML>'})`.

   To extend an existing body, read it first with `get_record('blog.post', <post_id>, fields=['content'])`
   and write back the full, extended HTML.

## Step 5 — Set tags (optional)

```
list_records('blog.tag', domain=[['name', 'in', ['<tag1>', '<tag2>']]], fields=['name'])
update('blog.post', <post_id>, {tag_ids: [[6, 0, [<tag_id_1>, <tag_id_2>]]]})
```

## Step 6 — SEO meta (optional but recommended before publishing)

```
update('blog.post', <post_id>, {
  website_meta_title: '<SEO title>',
  website_meta_description: '<Meta description — 150–160 chars>',
  website_meta_keywords: '<keyword1, keyword2>'
})
```

> SEO meta fields (`website_meta_title`, `website_meta_description`, `website_meta_keywords`) are
> `translate=True` — each language stores its own value. Set them in the source language here;
> translate them per-language in `translate_blog_post` (Step 2, SEO block).

## Step 7 — Publish

Only when content is reviewed and ready:
```
update('blog.post', <post_id>, {is_published: true, website_published: true})
```

## Verify

```
get_record('blog.post', <post_id>, fields=['name', 'subtitle', 'is_published', 'website_url'])
```
Visit `website_url` to confirm the post renders with cover image and body content.

## Next step

To translate this post into other languages: run workflow `translate_blog_post`.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| Cover image not displayed | `cover_properties` JSON malformed or attachment not public | Verify JSON, set `public: true` on attachment |
| Post not visible at URL | `is_published` still false | `update('blog.post', id, {is_published: true})` |
| Snippet body not editable in browser editor | `data-snippet` attr stripped during composition | Recompose using exact HTML from `get_snippet` |
| Arabic/non-ASCII URL is a bare ID (`/blog/ai-4/7`) | `seo_name` not set at creation; `slug()` discards non-ASCII chars and falls back to `str(id)` | Set `seo_name` now: read `website_url` in source lang, extract the slug segment (strip leading path and trailing `-{id}`), write via `update('blog.post', id, {'seo_name': '<slug>'})` |
