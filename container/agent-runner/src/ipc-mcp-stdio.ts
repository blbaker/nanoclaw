/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const FILES_DIR = path.join(IPC_DIR, 'files');
const ASKS_DIR = path.join(IPC_DIR, 'asks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

// Stage a file for delivery by copying it into /workspace/ipc/files/ with a
// unique basename. Returns the basename which the host's IPC processor will
// resolve back to a real host path for the channel adapter.
function stageAttachment(srcPath: string): string | null {
  if (typeof srcPath !== 'string' || srcPath.length === 0) return null;
  if (!fs.existsSync(srcPath)) return null;
  try {
    const st = fs.statSync(srcPath);
    if (!st.isFile()) return null;
    // Hard limit to avoid sending massive files. Discord max upload is 25MB
    // for free, 50MB for level 2 boost; we cap at 25MB to be safe.
    const MAX_BYTES = 25 * 1024 * 1024;
    if (st.size > MAX_BYTES) return null;
    fs.mkdirSync(FILES_DIR, { recursive: true });
    const basename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${path.basename(srcPath)}`;
    const dst = path.join(FILES_DIR, basename);
    fs.copyFileSync(srcPath, dst);
    return basename;
  } catch {
    return null;
  }
}

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. Optional `files` lets you attach images, video, audio, or documents — pass absolute paths inside the container (e.g. /tmp/screenshot.png from playwright, or /workspace/group/output/chart.png). Files >25MB are rejected. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    files: z
      .array(z.string())
      .optional()
      .describe(
        'Optional absolute file paths to attach. Examples: ["/tmp/screenshot.png"], ["/workspace/group/foo.mp4"]. Max 25MB per file. Channels that support attachments (Discord) upload them; channels that do not fall back to text only.',
      ),
    sender: z
      .string()
      .optional()
      .describe(
        'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
      ),
  },
  async (args) => {
    const stagedFiles: string[] = [];
    const failedFiles: string[] = [];
    if (Array.isArray(args.files)) {
      for (const f of args.files) {
        const basename = stageAttachment(f);
        if (basename) {
          stagedFiles.push(basename);
        } else {
          failedFiles.push(f);
        }
      }
    }

    const data: Record<string, unknown> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      files: stagedFiles.length > 0 ? stagedFiles : undefined,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    let report = `Message sent.`;
    if (stagedFiles.length > 0) {
      report += ` Attached ${stagedFiles.length} file${stagedFiles.length === 1 ? '' : 's'}.`;
    }
    if (failedFiles.length > 0) {
      report += ` Failed to attach (missing or >25MB): ${failedFiles.join(', ')}.`;
    }

    return { content: [{ type: 'text' as const, text: report }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
    script: z
      .string()
      .optional()
      .describe(
        'Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe('New schedule value (see schedule_task for format)'),
    script: z
      .string()
      .optional()
      .describe(
        'New script for the task. Set to empty string to remove the script.',
      ),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (
      args.schedule_type === 'cron' ||
      (!args.schedule_type && args.schedule_value)
    ) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid cron: "${args.schedule_value}".`,
              },
            ],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe(
        'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
      ),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    requiresTrigger: z
      .boolean()
      .optional()
      .describe(
        'Whether messages must start with the trigger word. Default: false (respond to all messages). Set to true for busy groups with many participants where you only want the agent to respond when explicitly mentioned.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      requiresTrigger: args.requiresTrigger ?? false,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

// memory_search — hybrid keyword + semantic search over the OpenClaw memory
// archive at /workspace/group/openclaw-workspace/memory.sqlite (60 files,
// 239 chunks). Three modes:
//   - "fts" (default): FTS5 keyword search. Fast, no extension needed.
//   - "semantic": Embeds the query via Ollama (nomic-embed-text at OLLAMA_URL),
//     runs sqlite-vec KNN over chunks_vec_vector_chunks00. Best for fuzzy
//     conceptual recall ("what did I say about ADHD time anchors").
//   - "hybrid": runs both, deduplicates by chunk id, ranks semantic first.
async function embedQueryViaOllama(query: string): Promise<number[] | null> {
  const ollamaUrl =
    process.env.OLLAMA_URL || 'http://192.168.1.115:11434';
  const url = `${ollamaUrl.replace(/\/$/, '')}/api/embeddings`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', prompt: query }),
      // 5s soft timeout via AbortController
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as { embedding?: number[] };
    return j.embedding || null;
  } catch {
    return null;
  }
}

server.tool(
  'memory_search',
  `Search the OpenClaw memory archive (60 files, 239 chunks: daily logs, instincts, swarm personas, MEMORY.md). Use this BEFORE answering memory-dependent questions. Modes: "fts" (keyword, default, fast, no Ollama), "semantic" (vector via Ollama nomic-embed-text), "hybrid" (both). Returns ranked matches with path, line range, snippet.`,
  {
    query: z
      .string()
      .describe(
        'Search query. For mode=fts: FTS5 syntax (AND, OR, NEAR, "phrase", prefix*). For semantic/hybrid: natural language.',
      ),
    mode: z
      .enum(['fts', 'semantic', 'hybrid'])
      .optional()
      .describe('Search mode. Default: fts.'),
    limit: z
      .number()
      .int()
      .optional()
      .describe('Max results (default 8, max 25).'),
  },
  async (args) => {
    const candidates = [
      '/workspace/group/openclaw-workspace/memory.sqlite',
      '/workspace/extra/openclaw-workspace/memory.sqlite',
    ];
    const dbPath = candidates.find((p) => fs.existsSync(p));
    if (!dbPath) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'memory_search: openclaw memory archive not found.',
          },
        ],
        isError: true,
      };
    }

    const limit = Math.min(Math.max(args.limit ?? 8, 1), 25);
    const mode = args.mode ?? 'fts';

    const Database = (await import('better-sqlite3')).default;
    const sqliteVec = await import('sqlite-vec');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });

    type Hit = {
      path: string;
      start_line: number;
      end_line: number;
      snippet: string;
      score: number;
      source: 'fts' | 'semantic';
    };

    const hits: Hit[] = [];

    try {
      // ----- FTS path -----
      if (mode === 'fts' || mode === 'hybrid') {
        try {
          const safe = args.query.replace(/"/g, '""');
          const rows = db
            .prepare(
              `SELECT c.id, c.path, c.start_line, c.end_line,
                      snippet(chunks_fts, 0, '«', '»', '…', 24) AS hit,
                      bm25(chunks_fts) AS score
               FROM chunks_fts
               JOIN chunks c ON c.id = chunks_fts.id
               WHERE chunks_fts MATCH ?
               ORDER BY score
               LIMIT ?`,
            )
            .all(safe, limit) as Array<{
            id: string;
            path: string;
            start_line: number;
            end_line: number;
            hit: string;
            score: number;
          }>;
          for (const r of rows) {
            hits.push({
              path: r.path,
              start_line: r.start_line,
              end_line: r.end_line,
              snippet: r.hit,
              score: r.score,
              source: 'fts',
            });
          }
        } catch (err) {
          // FTS may fail on malformed queries; non-fatal
          if (mode === 'fts') throw err;
        }
      }

      // ----- Semantic path -----
      if (mode === 'semantic' || mode === 'hybrid') {
        const embedding = await embedQueryViaOllama(args.query);
        if (!embedding) {
          if (mode === 'semantic') {
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `memory_search: semantic mode requires Ollama at ${process.env.OLLAMA_URL || 'http://192.168.1.115:11434'} with nomic-embed-text. Embedding call failed. Falling back to FTS by re-calling with mode="fts".`,
                },
              ],
              isError: true,
            };
          }
        } else {
          // Load sqlite-vec extension into this connection
          sqliteVec.load(db);
          const vectorBuf = Buffer.from(new Float32Array(embedding).buffer);
          // KNN over the vec0 index. The sqlite-vec virtual table is
          // "chunks_vec" with a "vector" column. Match rowids back through
          // chunks_vec_rowids → chunks.id.
          try {
            const rows = db
              .prepare(
                `SELECT c.id, c.path, c.start_line, c.end_line,
                        substr(c.text, 1, 240) AS preview,
                        v.distance AS dist
                 FROM (
                   SELECT rowid, distance
                   FROM chunks_vec
                   WHERE vector MATCH ?
                   ORDER BY distance
                   LIMIT ?
                 ) v
                 JOIN chunks_vec_rowids r ON r.rowid = v.rowid
                 JOIN chunks c ON c.id = r.id`,
              )
              .all(vectorBuf, limit) as Array<{
              id: string;
              path: string;
              start_line: number;
              end_line: number;
              preview: string;
              dist: number;
            }>;
            for (const r of rows) {
              // Skip if FTS already returned this exact chunk
              if (
                hits.some(
                  (h) =>
                    h.path === r.path && h.start_line === r.start_line,
                )
              ) {
                continue;
              }
              hits.push({
                path: r.path,
                start_line: r.start_line,
                end_line: r.end_line,
                snippet: r.preview,
                score: r.dist,
                source: 'semantic',
              });
            }
          } catch (err) {
            // sqlite-vec may not load on all builds; report and continue
            if (mode === 'semantic') {
              const msg = err instanceof Error ? err.message : String(err);
              return {
                content: [
                  {
                    type: 'text' as const,
                    text: `memory_search semantic failed: ${msg}. The sqlite-vec extension may not be loadable in this container. Use mode="fts".`,
                  },
                ],
                isError: true,
              };
            }
          }
        }
      }

      if (hits.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No matches for: ${args.query} (mode=${mode})`,
            },
          ],
        };
      }

      // For hybrid: semantic first, then FTS
      const ordered =
        mode === 'hybrid'
          ? [
              ...hits.filter((h) => h.source === 'semantic'),
              ...hits.filter((h) => h.source === 'fts'),
            ]
          : hits;

      const formatted = ordered
        .slice(0, limit)
        .map(
          (r, i) =>
            `${i + 1}. [${r.source}] ${r.path}:${r.start_line}-${r.end_line}\n   ${r.snippet.replace(/\n/g, ' ')}`,
        )
        .join('\n\n');

      return {
        content: [
          {
            type: 'text' as const,
            text: `Found ${ordered.length} match${ordered.length === 1 ? '' : 'es'} for "${args.query}" (mode=${mode}):\n\n${formatted}\n\nRead the file with the Read tool for full context.`,
          },
        ],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text' as const,
            text: `memory_search failed: ${msg}`,
          },
        ],
        isError: true,
      };
    } finally {
      db.close();
    }
  },
);

// usage_report — show recent token usage and approximate cost from the
// transcript JSONLs the SDK writes per session. Reads from
// /home/node/.claude/projects/-workspace-group/*.jsonl, which is the standard
// Claude Code session log path inside the container.
server.tool(
  'usage_report',
  `Report recent token usage and approximate cost across this group's sessions. Use to answer "how much have I spent today" or to debug long sessions. Returns per-session totals and a daily aggregate.`,
  {
    days: z
      .number()
      .int()
      .optional()
      .describe('How many days of history to scan (default 7, max 30).'),
  },
  async (args) => {
    const days = Math.min(Math.max(args.days ?? 7, 1), 30);
    const projectsDir = '/home/node/.claude/projects';
    if (!fs.existsSync(projectsDir)) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'usage_report: no project sessions found yet.',
          },
        ],
      };
    }

    type SessionTotals = {
      file: string;
      date: string;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    };
    const totals: SessionTotals[] = [];
    const cutoff = Date.now() - days * 86400_000;

    function walk(dir: string) {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        const st = fs.statSync(full);
        if (st.isDirectory()) {
          walk(full);
        } else if (name.endsWith('.jsonl') && st.mtimeMs >= cutoff) {
          const t: SessionTotals = {
            file: name,
            date: new Date(st.mtimeMs).toISOString().slice(0, 10),
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          };
          try {
            const lines = fs.readFileSync(full, 'utf-8').split('\n');
            for (const line of lines) {
              if (!line) continue;
              try {
                const ev = JSON.parse(line) as {
                  message?: { usage?: Record<string, number> };
                };
                const u = ev.message?.usage;
                if (u) {
                  t.input += u.input_tokens || 0;
                  t.output += u.output_tokens || 0;
                  t.cacheRead += u.cache_read_input_tokens || 0;
                  t.cacheWrite += u.cache_creation_input_tokens || 0;
                }
              } catch {
                // skip malformed lines
              }
            }
          } catch {
            // skip unreadable files
          }
          if (t.input || t.output) totals.push(t);
        }
      }
    }

    try {
      walk(projectsDir);
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `usage_report failed: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }

    if (totals.length === 0) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `No session usage found in the last ${days} days.`,
          },
        ],
      };
    }

    // Aggregate per day
    const byDate = new Map<string, SessionTotals>();
    for (const t of totals) {
      const a = byDate.get(t.date) || {
        file: '',
        date: t.date,
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      };
      a.input += t.input;
      a.output += t.output;
      a.cacheRead += t.cacheRead;
      a.cacheWrite += t.cacheWrite;
      byDate.set(t.date, a);
    }

    // Rough Opus 4.6 pricing (Anthropic pubished rates as of 2026):
    //   $15 / 1M input, $75 / 1M output, $1.50 / 1M cache read, $18.75 / 1M cache write
    // These are approximations — actual cost varies by model.
    function cost(t: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }) {
      return (
        (t.input / 1e6) * 15 +
        (t.output / 1e6) * 75 +
        (t.cacheRead / 1e6) * 1.5 +
        (t.cacheWrite / 1e6) * 18.75
      );
    }

    const dates = [...byDate.values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    const lines = dates.map(
      (d) =>
        `${d.date}  in:${d.input.toLocaleString().padStart(10)}  out:${d.output.toLocaleString().padStart(8)}  cache:${(d.cacheRead + d.cacheWrite).toLocaleString().padStart(10)}  ~$${cost(d).toFixed(2)}`,
    );

    const grand = dates.reduce(
      (acc, d) => ({
        input: acc.input + d.input,
        output: acc.output + d.output,
        cacheRead: acc.cacheRead + d.cacheRead,
        cacheWrite: acc.cacheWrite + d.cacheWrite,
      }),
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    );

    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Usage over ${days} days (${totals.length} sessions):\n\n` +
            lines.join('\n') +
            `\n\nTOTAL  in:${grand.input.toLocaleString()} out:${grand.output.toLocaleString()} cache:${(grand.cacheRead + grand.cacheWrite).toLocaleString()} ~$${cost(grand).toFixed(2)}\n\n(Pricing is approximate Opus 4.6 rates. Actual cost varies by model.)`,
        },
      ],
    };
  },
);

// ask_user — interactive multiple-choice prompt to the human via Discord
// reactions. Useful when the agent is about to do something with a few
// distinct paths and wants the user to pick. Falls back to a default
// (caller-supplied) on timeout or when the channel doesn't support it.
server.tool(
  'ask_user',
  `Ask Baker a multiple-choice question via Discord reactions and wait for his answer. The user can tap an emoji to choose. Returns the chosen option's \`value\`, or \`timeout\` if no response within \`timeoutSeconds\` (default 300 = 5 minutes), or \`unsupported\` if the channel can't handle interactive prompts. Use this when you're about to do something with 2-4 distinct paths and want the user to pick. Pass a sensible default in your prompt logic — if the answer comes back as 'timeout' or 'unsupported', use the default.`,
  {
    question: z
      .string()
      .describe('The question to ask. Be concise — 1-2 sentences.'),
    options: z
      .array(
        z.object({
          emoji: z
            .string()
            .describe(
              'A single Unicode emoji the user will tap. Examples: 👍, ⚡, 🔍, ✅, ❌, 🛑, 🚀, 💭. Must be unique within the question.',
            ),
          label: z
            .string()
            .describe('Short human-readable label shown next to the emoji.'),
          value: z
            .string()
            .describe(
              'Machine-readable value returned to you when this option is chosen. Use snake_case.',
            ),
        }),
      )
      .min(2)
      .max(8)
      .describe('Between 2 and 8 options.'),
    timeoutSeconds: z
      .number()
      .int()
      .optional()
      .describe(
        'How long to wait for an answer (default 300, max 900). On timeout, returns "timeout".',
      ),
  },
  async (args) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const reqPath = path.join(ASKS_DIR, `${id}.json`);
    const answerPath = path.join(ASKS_DIR, `${id}-answer.json`);
    const timeoutMs = Math.min(
      Math.max((args.timeoutSeconds ?? 300) * 1000, 5000),
      900000,
    );

    fs.mkdirSync(ASKS_DIR, { recursive: true });
    fs.writeFileSync(
      reqPath,
      JSON.stringify({
        type: 'ask_user',
        chatJid,
        groupFolder,
        question: args.question,
        options: args.options,
        timeoutMs,
        timestamp: new Date().toISOString(),
      }),
    );

    // Poll for the answer file. Add 10s grace beyond the host's timeout.
    const deadline = Date.now() + timeoutMs + 10000;
    while (Date.now() < deadline) {
      if (fs.existsSync(answerPath)) {
        try {
          const data = JSON.parse(fs.readFileSync(answerPath, 'utf-8')) as {
            answer?: string;
            reason?: string;
          };
          // Cleanup
          try {
            fs.unlinkSync(answerPath);
          } catch {
            /* ignore */
          }
          const answer = data.answer || 'timeout';
          return {
            content: [
              {
                type: 'text' as const,
                text: `User answered: ${answer}${data.reason ? ` (${data.reason})` : ''}`,
              },
            ],
          };
        } catch {
          // Partial write; keep polling.
        }
      }
      // Sleep 500ms between polls
      await new Promise((r) => setTimeout(r, 500));
    }

    return {
      content: [
        {
          type: 'text' as const,
          text: 'User answered: timeout',
        },
      ],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
