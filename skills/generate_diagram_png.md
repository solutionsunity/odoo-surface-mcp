---
name: generate_diagram_png
summary: Render a textual diagram (Mermaid, Graphviz, etc.) to a PNG file ready for upload to Odoo.
hint: |
  Use the local mermaid-cli (`mmdc` via npx) for full control over dimensions and background.
  Fall back to Kroki only when local rendering is unavailable. Output is a file on disk —
  combine with `upload_attachment` to register it as an `ir.attachment`.
applies_to:
  models: ["*"]
  operations: ["diagram", "image", "visual"]
tools_used: []
preconditions:
  - "Node.js with npx is available on the host (for mermaid-cli)."
  - "The diagram source is well-formed Mermaid or Kroki-supported syntax."
anti_patterns:
  - "Inlining raw Mermaid in arch_db — Odoo does not render it; embed as PNG via /web/image/{id}."
  - "Using preview services (mermaid.ink) for production assets — they may rate-limit or expire."
  - "Skipping the alt attribute when embedding — alt text is a translation term and accessibility requirement."
---

# Skill: Generate a diagram PNG

Produces a PNG image suitable for upload as an `ir.attachment` and embedding in a blog post or
website page via `/web/image/{id}`.

## Step 1 — Author the diagram source

Write the diagram in Mermaid (preferred) or another Kroki-supported DSL. Keep nodes concise, use
consistent shapes per type, and pick colors that read on both light and dark backgrounds.

Save the source to a temporary file, e.g. `tmp/diagram.mmd`.

## Step 2 — Render via local mermaid-cli (recommended)

```
npx --yes @mermaid-js/mermaid-cli -i tmp/diagram.mmd -o tmp/diagram.png -b white -w 1200
```

- `-b white`: forces white background — transparent backgrounds break in dark-mode website themes.
- `-w 1200`: minimum width for crisp rendering on retina displays.
- For taller diagrams, add `-H 800` to constrain height.

## Step 3 — Fallback: Kroki HTTP service

If `npx` is unavailable or the diagram type is not supported by mermaid-cli:

```python
import zlib, base64, urllib.request
src = open('tmp/diagram.mmd').read()
encoded = base64.urlsafe_b64encode(zlib.compress(src.encode(), 9)).decode()
url = f"https://kroki.io/mermaid/png/{encoded}"
urllib.request.urlretrieve(url, 'tmp/diagram.png')
```

Replace `mermaid` in the URL with the appropriate engine: `graphviz`, `plantuml`, `bpmn`, etc.

If Kroki returns `414 URI Too Long`, switch to POST:
```
curl -X POST --data-binary @tmp/diagram.mmd https://kroki.io/mermaid/png -o tmp/diagram.png
```

## Step 4 — Upload to Odoo

Apply skill `upload_attachment` to register `tmp/diagram.png` as an `ir.attachment` with
`public=true`. Capture the returned attachment id.

## Step 5 — Embed in content

In the target blog post or page `arch_db`:

```
<img src="/web/image/{attachment_id}" alt="<descriptive alt text>" class="img img-fluid"/>
```

Always set a meaningful `alt` — it becomes a translation term and is essential for accessibility.

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `mmdc: command not found` | npx package not cached and offline | Use Kroki fallback (Step 3) |
| Diagram renders blank | Mermaid syntax error silently swallowed | Run mmdc without `--quiet` to surface parse errors |
| PNG appears low-res in browser | Rendered below 1200px on retina | Re-render with `-w 1600` |
| Kroki returns `414 URI Too Long` | Diagram source too large for GET | Switch to POST form |
| Image broken after upload | Attachment not `public=true` | Update the attachment, set `public=true` |
