---
name: create_blog_post
summary: Create a blog.post record in the source language — title, subtitle, cover image, and structured body content.
skills: [upload_attachment, inject_snippet]
applies_to:
  models: [blog.post, blog.blog, blog.tag]
  operations: [create]
preconditions:
  - A `blog.blog` record exists to attach the post to (`search_records('blog.blog', [])` to list).
  - Post is created in the source language (usually `en_US`). For multilingual publishing, run `translate_blog_post` after editorial review.
---

# Workflow: Create a `blog.post` record

Source-language only. Translation is a separate lifecycle step — see `translate_blog_post`.

## Step 1 — Resolve blog id

```
search_records('blog.blog', [], fields=['id', 'name'])
```
Capture the target `blog.blog` id. If no blog exists, create one: `create('blog.blog', {name: 'My Blog'})`.

## Step 2 — Create the post skeleton

```
create('blog.post', {
  blog_id: <blog_id>,
  name: '<Post Title>',
  subtitle: '<Post Subtitle>',
  website_published: false,   # keep unpublished until content is ready
  is_published: false
})
```
Returns: `{ id: <post_id> }`

## Step 3 — Upload cover image

Apply skill `upload_attachment`:

**Option A — Unsplash (preferred):**
```
fetch_and_upload(query='<search term>', model='blog.post', record_id=<post_id>)
```
Capture the returned attachment id and `/web/image/<id>` URL.

**Option B — Binary file:**
Base64-encode locally, then:
```
create('ir.attachment', {
  name: 'cover.jpg', type: 'binary', datas: '<base64>',
  mimetype: 'image/jpeg', res_model: 'blog.post', res_id: <post_id>, public: true
})
```

**Option C — External URL:**
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

Apply skill `inject_snippet` for each content section:

1. `list_snippets()` — identify relevant snippet(s) (e.g. `s_text_image`, `s_text_block`, `s_three_columns`).
2. `get_snippet(name='<snippet_name>')` — fetch canonical HTML.
3. Read current arch: `get_page_arch(page_id=<post_view_id>)`.

   > To get the post's view id: `get_record('blog.post', post_id, fields=['website_id'])`.
   > Then find the view: `search_records('website.page', [['url', 'like', '<post_slug>']], fields=['view_id'])`.
   > Or use `list_pages()` filtered by post URL.

4. Inject snippet(s) into the arch preserving outer wrappers. Fill editable placeholders with actual content.
5. `set_page_arch(page_id=<view_id>, arch='<full arch>')`.

## Step 5 — Set tags (optional)

```
search_records('blog.tag', [['name', 'in', ['<tag1>', '<tag2>']]], fields=['id', 'name'])
update('blog.post', <post_id>, {tag_ids: [[6, 0, [<tag_id_1>, <tag_id_2>]]]})
```

## Step 6 — SEO meta (optional)

```
update('blog.post', <post_id>, {
  website_meta_title: '<SEO title>',
  website_meta_description: '<Meta description>',
  website_meta_keywords: '<keyword1, keyword2>'
})
```

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
| Snippet body not editable in browser editor | `data-snippet` attr stripped during inject | Re-inject using exact HTML from `get_snippet` |
