# Architecture

**Status.** Adopted 2026-10-03. Rule 1 is enforced by `npm run check:arch` (`scripts/check-arch.mjs`),
run in CI (`.github/workflows/check.yml`).

---

## Layers

| Layer | Location | Owns | Never |
|---|---|---|---|
| Tools | `src/tools/` | MCP interface: parameters, descriptions, output shape | compares versions, handles a series-specific Odoo shape |
| Operations | `src/odoo/` | Odoo operations whose call or result differs across series — one function each, one output shape | MCP concerns |
| Client | `src/odooClient.ts` | transport, session, target version | model-specific logic |

Tools call an operation for anything version-dependent, and `client.execute` directly for calls
identical across the supported range. A call moves into an operation when it starts to diverge;
`docs/compatibility.md` lists every call per series and is where divergence is detected.

---

## Version routing — `since`

An operation is a table of implementations keyed by the series each one starts at:

```ts
export const views = since({
  '15.0': (c, model, type) => /* load_views */,
  '16.0': (c, model, type) => /* get_views, type 'tree' */,
  '18.0': (c, model, type) => /* get_views, type 'list', models[m].fields */,
});
```

- **Keys** are series: `'17.0'`, `'saas~18.3'` — compared as `(major, minor)`.
- **Segments.** Each key starts a segment that runs until the next key. The target resolves to
  the greatest key ≤ its version.
- **Floor.** The supported floor is one constant. Every table's first key equals it — checked
  when the table is defined. A target below the floor is an unsupported-version error.
- **Gaps.** A segment where the operation does not exist (not yet introduced, or removed without
  replacement) is an explicit `unavailable(reason)` entry. Calling it is an error naming the
  operation, the target series and the reason.
- **Removal with replacement** is an ordinary key: the new segment carries the new implementation.
- **SaaS.** Keys at SaaS granularity are added only once verified against the SaaS branch; until
  then a SaaS target resolves within its major's segment — deliberate scope decision.
- **Tools stay registered** on every series. The version is known only after authentication; an
  operation unavailable on the target answers with its error.

---

## Rules

1. Only `src/odoo/` resolves versions. Tools and the client's transport never compare them.
2. One divergence, one home: each is handled once, in its operation's table.
3. An operation returns the same shape on every series.
4. Fail loud. A failed or unsupported call is an error — never an empty, partial or default result
   standing in for one.
5. Each table key carries a comment citing the Odoo source that justifies it
   (`18.0/odoo/addons/base/models/ir_ui_view.py:2631`). Code never cites these documents.
6. Adding a series: audit every call against its source, update `docs/compatibility.md`, add keys
   only where behaviour changed.
