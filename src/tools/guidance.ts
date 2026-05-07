/** Layer 0 — Guidance: skills and workflows that tell agents how to compose tools deterministically. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { OdooClient } from '../odooClient.js';
import { Cache } from '../cache.js';
import { ok } from '../utils.js';

// ─── Paths ───────────────────────────────────────────────────────────────────
// Compiled file lives at dist/tools/guidance.js → package root is two levels up.
const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = join(HERE, '..', '..', 'skills');
const WORKFLOWS_DIR = join(HERE, '..', '..', 'workflows');

// ─── Types ───────────────────────────────────────────────────────────────────

interface SkillFront {
  name: string;
  summary?: string;
  hint?: string;
  applies_to?: { field_types?: string[]; models?: string[]; operations?: string[] };
  tools_used?: string[];
  preconditions?: string[];
  anti_patterns?: string[];
}
interface WorkflowFront {
  name: string;
  summary?: string;
  skills?: string[];
  applies_to?: { models?: string[]; operations?: string[] };
  preconditions?: string[];
}
interface Doc<T> { front: T; body: string }

// ─── Loaders (no cache: dirs are tiny, freshness > microseconds) ─────────────

function splitFrontmatter(raw: string): { front: unknown; body: string } {
  if (!raw.startsWith('---')) return { front: {}, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end < 0) return { front: {}, body: raw };
  const yamlText = raw.slice(3, end).replace(/^\r?\n/, '');
  const body = raw.slice(end + 4).replace(/^\r?\n/, '');
  return { front: parseYaml(yamlText) ?? {}, body };
}

function loadDir<T>(dir: string): Doc<T>[] {
  let files: string[];
  try { files = readdirSync(dir).filter(f => f.endsWith('.md')); }
  catch { return []; }
  return files.map(f => {
    const raw = readFileSync(join(dir, f), 'utf8');
    const { front, body } = splitFrontmatter(raw);
    const fm = (front ?? {}) as T & { name?: string };
    if (!fm.name) fm.name = f.replace(/\.md$/, '');
    return { front: fm as T, body };
  });
}

const loadSkills = (): Doc<SkillFront>[] => loadDir<SkillFront>(SKILLS_DIR);
const loadWorkflows = (): Doc<WorkflowFront>[] => loadDir<WorkflowFront>(WORKFLOWS_DIR);

/** Build skill_name → [workflow_name, ...] back-reference map. */
function buildUsedIn(workflows: Doc<WorkflowFront>[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const wf of workflows) {
    for (const skill of wf.front.skills ?? []) {
      if (!map.has(skill)) map.set(skill, []);
      map.get(skill)!.push(wf.front.name);
    }
  }
  return map;
}

function matchAny(needle: string | undefined, haystack: string[] | undefined): boolean {
  if (!needle) return true;
  if (!haystack || haystack.length === 0) return false;
  return haystack.includes(needle) || haystack.includes('*');
}

// ─── Register ────────────────────────────────────────────────────────────────

export function register(server: McpServer, _client: OdooClient, _cache: Cache): void {

  server.registerTool('list_skills', {
    description:
      'List all atomic skills (canonical recipes for ONE thing). Returns name, summary, ' +
      'hint, applies_to, and used_in (workflows that compose this skill). No body — call get_skill for full text.',
    inputSchema: {},
  }, async () => {
    try {
      const skills = loadSkills();
      const usedIn = buildUsedIn(loadWorkflows());
      return ok(skills.map(s => ({
        name: s.front.name,
        summary: s.front.summary ?? '',
        hint: s.front.hint ?? '',
        applies_to: s.front.applies_to ?? {},
        tools_used: s.front.tools_used ?? [],
        used_in: usedIn.get(s.front.name) ?? [],
      })));
    } catch (e) { return ok({ error: String(e) }); }
  });

  server.registerTool('get_skill', {
    description: 'Return one skill in full: frontmatter + markdown body + used_in back-references.',
    inputSchema: { name: z.string() },
  }, async ({ name }) => {
    try {
      const skill = loadSkills().find(s => s.front.name === name);
      if (!skill) return ok({ error: `skill '${name}' not found` });
      const usedIn = buildUsedIn(loadWorkflows()).get(name) ?? [];
      return ok({ ...skill.front, used_in: usedIn, body: skill.body });
    } catch (e) { return ok({ error: String(e) }); }
  });

  server.registerTool('find_skill', {
    description:
      'Find skills matching a situation. Filters by model, field_type, and/or operation against ' +
      'each skill\'s applies_to. Returns full skill records (with body) for all matches; empty array if none.',
    inputSchema: {
      model: z.string().optional(),
      field_type: z.string().optional(),
      operation: z.string().optional(),
    },
  }, async ({ model, field_type, operation }) => {
    try {
      const skills = loadSkills();
      const usedIn = buildUsedIn(loadWorkflows());
      const matches = skills.filter(s => {
        const a = s.front.applies_to ?? {};
        return matchAny(model, a.models)
          && matchAny(field_type, a.field_types)
          && matchAny(operation, a.operations);
      });
      return ok(matches.map(s => ({
        ...s.front,
        used_in: usedIn.get(s.front.name) ?? [],
        body: s.body,
      })));
    } catch (e) { return ok({ error: String(e) }); }
  });

  server.registerTool('list_workflows', {
    description:
      'List all multi-step workflows. Returns name, summary, applies_to, and the skills each workflow composes. ' +
      'No body — call get_workflow for full text.',
    inputSchema: {},
  }, async () => {
    try {
      return ok(loadWorkflows().map(w => ({
        name: w.front.name,
        summary: w.front.summary ?? '',
        applies_to: w.front.applies_to ?? {},
        skills: w.front.skills ?? [],
      })));
    } catch (e) { return ok({ error: String(e) }); }
  });

  server.registerTool('get_workflow', {
    description:
      'Return one workflow in full: frontmatter + markdown body. With expand_skills=true, ' +
      'also append the body of every skill listed in `skills:` (composition view).',
    inputSchema: { name: z.string(), expand_skills: z.boolean().optional() },
  }, async ({ name, expand_skills }) => {
    try {
      const wf = loadWorkflows().find(w => w.front.name === name);
      if (!wf) return ok({ error: `workflow '${name}' not found` });
      const result: Record<string, unknown> = { ...wf.front, body: wf.body };
      if (expand_skills) {
        const allSkills = loadSkills();
        const expanded = (wf.front.skills ?? []).map(sn => {
          const sk = allSkills.find(s => s.front.name === sn);
          return sk ? { name: sn, body: sk.body } : { name: sn, error: 'skill not found' };
        });
        result.expanded_skills = expanded;
      }
      return ok(result);
    } catch (e) { return ok({ error: String(e) }); }
  });
}
