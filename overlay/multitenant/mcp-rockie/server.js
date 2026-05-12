#!/usr/bin/env node
/**
 * mcp-rockie — MCP server giving claude/codex access to the tenant's
 * Rockie tool surface (labs, sources, notes, artifacts, search, compute,
 * emit_artifact fan-out).
 *
 * The tool catalog mirrors `platform-context/api/agent_tools/schemas.py`
 * (single source of truth — keep in lockstep; a parity test will fail
 * on drift). Every tool call PROXIES to platform-context via the per-
 * tenant HTTP surface at /api/agent-tools/{name}; the broker already
 * has the same env vars wired:
 *
 *   ROCKIELAB_API_BASE          (default https://api.rockielab.com)
 *   ROCKIELAB_API_PASSWORD      (mirrors OPEN_NOTEBOOK_PASSWORD)
 *   ROCKIELAB_TENANT_DEV_TOKEN  (per-tenant; eventually a signed JWT)
 *
 * Registered into ~/.claude/mcp.json + ~/.codex/mcp.json at image
 * build time (see Dockerfile.multitenant + assemble-skills.sh).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const API_BASE =
  process.env.ROCKIELAB_API_BASE || 'https://api.rockielab.com'
const API_PASSWORD =
  process.env.ROCKIELAB_API_PASSWORD || process.env.OPEN_NOTEBOOK_PASSWORD || ''
const TENANT_TOKEN = process.env.ROCKIELAB_TENANT_DEV_TOKEN || ''

// Tool catalog. Keep in lockstep with
// platform-context/api/agent_tools/schemas.py. A parity test in
// platform-context/tests/test_agent_tools.py asserts the name sets
// match.
const TOOLS = [
  {
    name: 'notebook_read',
    description:
      "Read a lab's metadata + a summary of its sources and notes. Use when the user names a specific lab or you need to ground the next action in a lab's contents.",
    inputSchema: {
      type: 'object',
      properties: { notebook_id: { type: 'string' } },
      required: ['notebook_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'notebook_create',
    description:
      'Create a new lab (notebook). Use sparingly; only when the user explicitly asks for a new workspace.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', minLength: 1, maxLength: 200 },
        description: { type: 'string', default: '' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'notebook_update',
    description:
      'Rename or repitch a lab. Provide at least one of name/description.',
    inputSchema: {
      type: 'object',
      properties: {
        notebook_id: { type: 'string' },
        name: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['notebook_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'source_ingest',
    description:
      "Ingest content into a lab. Pass exactly one of url / text / file_path. Delegates to the platform's content extraction pipeline.",
    inputSchema: {
      type: 'object',
      properties: {
        notebook_id: { type: 'string' },
        url: { type: 'string' },
        text: { type: 'string' },
        file_path: { type: 'string' },
        title: { type: 'string' },
      },
      required: ['notebook_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'source_read',
    description:
      "Read one source's extracted text + metadata. Heavyweight; only call when the listing preview is not enough.",
    inputSchema: {
      type: 'object',
      properties: { source_id: { type: 'string' } },
      required: ['source_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'note_create',
    description:
      'Create a note in a lab. Use to persist a hypothesis, finding, or running summary so the user can see it later.',
    inputSchema: {
      type: 'object',
      properties: {
        notebook_id: { type: 'string' },
        body: { type: 'string', minLength: 1 },
        title: { type: 'string' },
        source_ids: { type: 'array', items: { type: 'string' } },
      },
      required: ['notebook_id', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'note_update',
    description: "Edit an existing note's body or title.",
    inputSchema: {
      type: 'object',
      properties: {
        note_id: { type: 'string' },
        body: { type: 'string' },
        title: { type: 'string' },
      },
      required: ['note_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'note_delete',
    description:
      'Delete a note. Idempotent — deleting a missing note is not an error.',
    inputSchema: {
      type: 'object',
      properties: { note_id: { type: 'string' } },
      required: ['note_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'insight_list',
    description: 'List insights derived from a source.',
    inputSchema: {
      type: 'object',
      properties: { source_id: { type: 'string' } },
      required: ['source_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'transformation_execute',
    description:
      'Apply a named transformation graph to a source. Returns a command id; poll job_status to follow it.',
    inputSchema: {
      type: 'object',
      properties: {
        source_id: { type: 'string' },
        transformation_id: { type: 'string' },
      },
      required: ['source_id', 'transformation_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'podcast_generate',
    description:
      'Generate a podcast episode (outline + transcript + TTS). Returns a job id; poll job_status for completion.',
    inputSchema: {
      type: 'object',
      properties: {
        notebook_id: { type: 'string' },
        profile_id: { type: 'string' },
        episode_name: { type: 'string' },
      },
      required: ['notebook_id', 'profile_id', 'episode_name'],
      additionalProperties: false,
    },
  },
  {
    name: 'artifact_list',
    description: 'List artifacts attached to a lab.',
    inputSchema: {
      type: 'object',
      properties: {
        notebook_id: { type: 'string' },
        kind: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
      },
      required: ['notebook_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'artifact_retrieve',
    description: 'Fetch artifact metadata + a URL or inline body.',
    inputSchema: {
      type: 'object',
      properties: { artifact_id: { type: 'string' } },
      required: ['artifact_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_query',
    description:
      "Vector + text search over the tenant's sources + notes. Returns top-k hits with relevance scores. Use for grounding answers in the user's corpus.",
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        notebook_id: { type: 'string' },
        k: { type: 'integer', minimum: 1, maximum: 50, default: 10 },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'ask_question',
    description:
      'Multi-stage Ask workflow over the corpus (search → reason → synthesize). Heavier than search_query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', minLength: 1 },
        notebook_id: { type: 'string' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'experiment_submit',
    description:
      "Dispatch an experiment to the tenant's configured compute target (rockie_gpu / byo_ssh / byo_github / artifact_only).",
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', minLength: 1 },
        env: { type: 'object' },
        timeout_sec: { type: 'integer', minimum: 1, maximum: 86400 },
        gpu_type: { type: 'string' },
      },
      required: ['script'],
      additionalProperties: false,
    },
  },
  {
    name: 'job_status',
    description:
      'Poll a previously-submitted experiment by its handle. Returns state + progress + any artifacts produced.',
    inputSchema: {
      type: 'object',
      properties: { handle: { type: 'string' } },
      required: ['handle'],
      additionalProperties: false,
    },
  },
  // --- Karpathy autoresearch journal (MVP step 8) ---
  {
    name: 'hypothesis_register',
    description:
      "Register a new hypothesis in a lab's journal. Status defaults to 'proposed'. Optionally link source_ids for grounding and parent_hypothesis_id for refinement chains.",
    inputSchema: {
      type: 'object',
      properties: {
        lab_id: { type: 'string' },
        statement: { type: 'string', minLength: 1 },
        status: {
          type: 'string',
          enum: ['proposed', 'active', 'supported', 'falsified', 'parked'],
          default: 'proposed',
        },
        source_ids: { type: 'array', items: { type: 'string' }, default: [] },
        parent_hypothesis_id: { type: 'string' },
      },
      required: ['lab_id', 'statement'],
      additionalProperties: false,
    },
  },
  {
    name: 'hypothesis_update',
    description:
      "Update a hypothesis. Append-only: writes a new version row and supersedes the previous. Enforces the state machine (no jump from 'proposed' to 'supported'). verdict_reasoning (>= 20 chars of prose) is REQUIRED on any transition landing on 'supported' or 'falsified' — explain why before claiming the verdict.",
    inputSchema: {
      type: 'object',
      properties: {
        hypothesis_id: { type: 'string' },
        status: {
          type: 'string',
          enum: ['proposed', 'active', 'supported', 'falsified', 'parked'],
        },
        statement: { type: 'string', minLength: 1 },
        supporting_artifact_ids: {
          type: 'array',
          items: { type: 'string' },
          default: [],
        },
        verdict_reasoning: {
          type: 'string',
          minLength: 20,
          description:
            "Prose justification for a supported/falsified verdict. Required when status transitions onto supported or falsified.",
        },
      },
      required: ['hypothesis_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'hypothesis_list',
    description:
      "List the latest version of every hypothesis in a lab. Default filter is 'proposed | active' (open work).",
    inputSchema: {
      type: 'object',
      properties: {
        lab_id: { type: 'string' },
        status: {
          type: 'string',
          enum: ['proposed', 'active', 'supported', 'falsified', 'parked'],
        },
      },
      required: ['lab_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'dead_end_record',
    description:
      "Record a dead-end. Once recorded, the agent should search this registry before re-attempting any approach. `reasoning` (>= 20 chars) is REQUIRED so future agents understand WHY the approach failed.",
    inputSchema: {
      type: 'object',
      properties: {
        lab_id: { type: 'string' },
        what_failed: { type: 'string', minLength: 1 },
        reasoning: {
          type: 'string',
          minLength: 20,
          description:
            'Prose explanation of why the approach failed. Required (>= 20 chars).',
        },
        related_hypothesis_id: { type: 'string' },
        related_experiment_id: { type: 'string' },
      },
      required: ['lab_id', 'what_failed', 'reasoning'],
      additionalProperties: false,
    },
  },
  {
    name: 'dead_end_search',
    description:
      "Full-text search the lab's dead-end registry. Use BEFORE proposing a new approach to avoid re-walking known bad paths.",
    inputSchema: {
      type: 'object',
      properties: {
        lab_id: { type: 'string' },
        query: { type: 'string', minLength: 1 },
        top_k: { type: 'integer', minimum: 1, maximum: 50, default: 5 },
      },
      required: ['lab_id', 'query'],
      additionalProperties: false,
    },
  },
  {
    name: 'calibration_record',
    description:
      "Capture the agent's stated prior on a hypothesis. Used to grade calibration later (Brier score).",
    inputSchema: {
      type: 'object',
      properties: {
        hypothesis_id: { type: 'string' },
        claimed_probability: { type: 'number', minimum: 0.0, maximum: 1.0 },
        claimed_at: { type: 'string' },
        resolved_at: { type: 'string' },
        actual_outcome: { type: 'number', minimum: 0.0, maximum: 1.0 },
      },
      required: ['hypothesis_id', 'claimed_probability'],
      additionalProperties: false,
    },
  },
  {
    name: 'calibration_resolve',
    description:
      "Close out a calibration by setting its actual_outcome (1.0 if the linked hypothesis ended 'supported', 0.0 if 'falsified').",
    inputSchema: {
      type: 'object',
      properties: {
        calibration_id: { type: 'string' },
        actual_outcome: { type: 'number', minimum: 0.0, maximum: 1.0 },
      },
      required: ['calibration_id', 'actual_outcome'],
      additionalProperties: false,
    },
  },
  {
    name: 'calibration_brier_score',
    description:
      "Compute the lab's running Brier score over resolved calibrations. Lower is better.",
    inputSchema: {
      type: 'object',
      properties: {
        lab_id: { type: 'string' },
      },
      required: ['lab_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'experiment_link',
    description:
      "Link an experiment to a hypothesis with an explicit role ('tests' | 'supports' | 'invalidates'). Many-to-many.",
    inputSchema: {
      type: 'object',
      properties: {
        experiment_id: { type: 'string' },
        hypothesis_id: { type: 'string' },
        role: {
          type: 'string',
          enum: ['tests', 'supports', 'invalidates'],
          default: 'tests',
        },
      },
      required: ['experiment_id', 'hypothesis_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'lab_journal_read',
    description:
      "Single call returning the full journal for a lab (hypotheses, dead_ends, calibrations, links). The rockie-loop daemon uses this on every wake to ground its planning.",
    inputSchema: {
      type: 'object',
      properties: {
        lab_id: { type: 'string' },
        since: { type: 'string' },
      },
      required: ['lab_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'emit_artifact',
    description:
      "Publish an artifact to up to four destinations in parallel (chat, ui, github, huggingface). Each destination's success/failure is independent so the agent can retry one channel without re-doing the successful ones.",
    inputSchema: {
      type: 'object',
      properties: {
        kind: {
          type: 'string',
          enum: [
            'plot',
            'table',
            'markdown',
            'model_weights',
            'paper_pdf',
            'dataset',
            'code',
            'podcast_episode',
          ],
        },
        content: { type: 'string' },
        title: { type: 'string', minLength: 1, maxLength: 200 },
        notebook_id: { type: 'string' },
        destinations: {
          type: 'array',
          items: {
            type: 'string',
            enum: ['chat', 'ui', 'github', 'huggingface'],
          },
          default: ['chat', 'ui'],
          minItems: 1,
        },
        github_target: {
          type: 'object',
          properties: {
            repo: { type: 'string' },
            path: { type: 'string' },
            branch: { type: 'string', default: 'main' },
            message: { type: 'string' },
          },
          required: ['repo', 'path'],
          additionalProperties: false,
        },
        huggingface_target: {
          type: 'object',
          properties: {
            repo: { type: 'string' },
            path: { type: 'string' },
            kind: {
              type: 'string',
              enum: ['model', 'dataset', 'space'],
              default: 'dataset',
            },
          },
          required: ['repo'],
          additionalProperties: false,
        },
      },
      required: ['kind', 'content', 'title', 'notebook_id'],
      additionalProperties: false,
    },
  },
]

function authHeaders() {
  const h = { 'Content-Type': 'application/json' }
  if (API_PASSWORD) h['Authorization'] = `Bearer ${API_PASSWORD}`
  if (TENANT_TOKEN) h['X-Tenant-Token'] = TENANT_TOKEN
  return h
}

async function callTool(name, args) {
  const url = `${API_BASE}/api/agent-tools/${encodeURIComponent(name)}`
  const r = await fetch(url, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ arguments: args || {} }),
  })
  const text = await r.text()
  if (!r.ok) {
    let detail
    try {
      detail = JSON.parse(text)
    } catch {
      detail = { error: { code: 'http_error', message: text.slice(0, 240) } }
    }
    const err = new Error(
      detail.detail?.error?.message ||
        detail.error?.message ||
        `${name} → ${r.status}`,
    )
    err.status = r.status
    err.code = detail.detail?.error?.code || detail.error?.code || 'http_error'
    throw err
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

const server = new Server(
  { name: 'mcp-rockie', version: '0.2.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params
  // Quick local check so unknown-tool errors don't make a round-trip.
  if (!TOOLS.find((t) => t.name === name)) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ error: { code: 'unknown_tool', message: `unknown tool: ${name}` } }),
        },
      ],
      isError: true,
    }
  }
  try {
    const result = await callTool(name, args)
    return {
      content: [
        {
          type: 'text',
          text:
            typeof result === 'string'
              ? result
              : JSON.stringify(result, null, 2).slice(0, 32000),
        },
      ],
    }
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: {
              code: err?.code || 'tool_error',
              message: err?.message || String(err),
            },
          }),
        },
      ],
      isError: true,
    }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
