/** Layer 5 — Website tools: list_pages, get_page_arch, set_page_arch, set_page_visibility, fetch_and_upload, list_attachments. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { OdooClient } from '../odooClient.js';
import { Cache } from '../cache.js';
import { ok, GUIDANCE_HINT } from '../utils.js';

export function register(server: McpServer, client: OdooClient, _cache: Cache): void {

  server.registerTool(
    'list_pages',
    {
      description:
        'List website pages. Returns id, name, url, is_published, view_id, website_id for each page.',
      inputSchema: { website_id: z.number().int().optional() },
    },
    async ({ website_id }) => {
      try {
        const domain: unknown[] = [];
        if (website_id !== undefined) domain.push(['website_id', '=', website_id]);
        type PageRow = { id: number; name: string; url: string; is_published: boolean; view_id: [number, string] | false; website_id: [number, string] | false };
        const pages = await client.execute('website.page', 'search_read',
          [domain],
          { fields: ['id', 'name', 'url', 'is_published', 'view_id', 'website_id'] },
        ) as PageRow[];
        return ok(pages.map(p => ({
          id: p.id,
          name: p.name,
          url: p.url,
          is_published: p.is_published,
          view_id: Array.isArray(p.view_id) ? p.view_id[0] : null,
          website_id: Array.isArray(p.website_id) ? p.website_id[0] : null,
        })));
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'get_page_arch',
    {
      description:
        'Return the raw arch_db XML of a website page\'s view. ' +
        'Pass page_id from list_pages. Returns {view_id, arch_db}. ' +
        'The AI is responsible for reading and editing this XML.',
      inputSchema: { page_id: z.number().int() },
    },
    async ({ page_id }) => {
      try {
        type PageViewRow = { view_id: [number, string] | false };
        const pages = await client.execute('website.page', 'read',
          [[page_id]], { fields: ['view_id'] },
        ) as PageViewRow[];
        if (!pages.length || !Array.isArray(pages[0].view_id)) {
          return ok({ error: `Page ${page_id} not found or has no view` });
        }
        const view_id = pages[0].view_id[0];
        const views = await client.execute('ir.ui.view', 'read',
          [[view_id]], { fields: ['arch_db'] },
        ) as Array<{ arch_db: string }>;
        if (!views.length) return ok({ error: `View ${view_id} not found` });
        return ok({ view_id, arch_db: views[0].arch_db });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'set_page_arch',
    {
      description:
        GUIDANCE_HINT +
        'Write arch_db XML to an ir.ui.view. Use view_id from get_page_arch. ' +
        'The caller is fully responsible for valid, well-formed XML.',
      inputSchema: { view_id: z.number().int(), arch: z.string() },
    },
    async ({ view_id, arch }) => {
      try {
        await client.execute('ir.ui.view', 'write', [[view_id], { arch_db: arch }]);
        return ok({ success: true, view_id });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );

  server.registerTool(
    'set_page_visibility',
    {
      description: GUIDANCE_HINT + 'Publish or unpublish a website page.',
      inputSchema: { page_id: z.number().int(), is_published: z.boolean() },
    },
    async ({ page_id, is_published }) => {
      try {
        await client.execute('website.page', 'write', [[page_id], { is_published }]);
        return ok({ success: true, page_id, is_published });
      } catch (e) { return ok({ error: String(e) }); }
    },
  );
}
