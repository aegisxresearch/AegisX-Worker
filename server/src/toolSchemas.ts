import type { LlmTool } from './llm.ts';
import { ROLE_PACK_IDS } from './rolePacks.ts';
import { toolsForPhase, type ToolPhase } from './router.ts';

const stringParam = (description: string): Record<string, unknown> => ({ type: 'string', description });

/** Office actions — always available, they drive the 3D scene. */
const OFFICE_TOOLS: LlmTool[] = [
  {
    type: 'function',
    function: {
      name: 'move_to',
      description: 'Walk to a place in the office.',
      parameters: {
        type: 'object',
        properties: {
          station: {
            type: 'string',
            enum: ['desk', 'meeting', 'coffee', 'board', 'lounge'],
            description: 'Where to go.',
          },
        },
        required: ['station'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_status',
      description: 'Change the visible work status shown on the worker and the board.',
      parameters: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['idle', 'working', 'blocked', 'error', 'meeting'],
          },
          reason: stringParam('Short explanation shown next to the status.'),
        },
        required: ['status'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'complete_task',
      description: 'Mark the assigned task as finished. Only call this when the work is truly done.',
      parameters: {
        type: 'object',
        properties: {
          summary: stringParam('What was delivered and the result.'),
          remember: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 6,
            description:
              'Durable facts about THIS folder that the next mission should know — the command that builds or tests it, where the entry points live, conventions or gotchas you hit. One short line each. Skip anything that only applies to this one task.',
          },
        },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'add_note',
      description: 'Attach a durable note to the current task.',
      parameters: {
        type: 'object',
        properties: { text: stringParam('The note to record.') },
        required: ['text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_task',
      description: 'Create a task, optionally handing it to a colleague by name.',
      parameters: {
        type: 'object',
        properties: {
          title: stringParam('Short task title.'),
          detail: stringParam('What has to be done.'),
          priority: { type: 'string', enum: ['low', 'medium', 'high', 'urgent'] },
          assignee: stringParam('Colleague name from the roster. Omit to leave it unassigned.'),
          depends_on: {
            type: 'array',
            items: { type: 'string' },
            maxItems: 8,
            description:
              'Task ids that must be done before this one starts. The runtime queues it and wakes it when the last dependency finishes, so the team does not have to wait between turns.',
          },
          role_pack: {
            type: 'string',
            enum: ROLE_PACK_IDS,
            description:
              'The playbook the worker should run under, when the craft of this task differs from the assignee\'s job title (a migration handed to a generalist, a prompt file handed to an engineer). Omit to let the role and the brief decide.',
          },
        },
        required: ['title'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'speak',
      description: 'Show a short line in the speech bubble above the worker.',
      parameters: {
        type: 'object',
        properties: { text: stringParam('One short sentence.') },
        required: ['text'],
      },
    },
  },
];

/** Filesystem and shell tools — only offered when the operator enables them. */
const FILE_TOOLS: LlmTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List the files and folders inside a workspace path.',
      parameters: {
        type: 'object',
        properties: { path: stringParam('Workspace-relative path. Use "." for the root.') },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read a text file from the workspace. Long files come back as a window; page through them with offset.',
      parameters: {
        type: 'object',
        properties: {
          path: stringParam('Workspace-relative path of the file.'),
          offset: { type: 'integer', description: 'First line to return, 1-based. Defaults to 1.' },
          limit: { type: 'integer', description: 'How many lines to return (max 400). Defaults to 400.' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create or overwrite a text file in the workspace.',
      parameters: {
        type: 'object',
        properties: {
          path: stringParam('Workspace-relative path of the file.'),
          content: stringParam('Full new content of the file.'),
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'append_file',
      description: 'Append text to an existing file (or create it).',
      parameters: {
        type: 'object',
        properties: {
          path: stringParam('Workspace-relative path of the file.'),
          content: stringParam('Text to add at the end of the file.'),
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Replace a snippet inside a file. Matches the text as written, and still matches when only indentation or trailing whitespace differs. Replaces the first occurrence unless replace_all is true.',
      parameters: {
        type: 'object',
        properties: {
          path: stringParam('Workspace-relative path of the file.'),
          search: stringParam('Text to find. Copy it from read_file; indentation may differ.'),
          replace: stringParam('Replacement text. Use an empty string to delete.'),
          replace_all: { type: 'boolean', description: 'Replace every occurrence instead of the first.' },
        },
        required: ['path', 'search', 'replace'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file or folder inside the workspace.',
      parameters: {
        type: 'object',
        properties: { path: stringParam('Workspace-relative path to delete.') },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search file contents inside the workspace for a literal string.',
      parameters: {
        type: 'object',
        properties: {
          pattern: stringParam('Literal text to look for.'),
          path: stringParam('Workspace-relative folder to search. Defaults to the root.'),
          max_results: { type: 'integer', description: 'Maximum number of matching lines.' },
        },
        required: ['pattern'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'preview_screenshot',
      description:
        'Render an HTML page from the workspace in headless Chrome and save a PNG. Use it to see the real layout before claiming a page is finished.',
      parameters: {
        type: 'object',
        properties: {
          path: stringParam('Workspace-relative HTML file. Defaults to index.html.'),
          width: { type: 'integer', description: 'Viewport width in px. Try 375 and 1440.' },
          height: { type: 'integer', description: 'Viewport height in px. Use a tall value for a full page.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'start_process',
      description:
        'Start a long-running command (a dev server, a watcher) inside the workspace and keep it running in the background. Use this instead of run_command, which waits for exit. Returns an id for process_logs, port_status and stop_process.',
      parameters: {
        type: 'object',
        properties: {
          command: stringParam(
            'One command, for example "node server.js". No pipes, redirects or chaining — its output goes to the process log.',
          ),
          label: stringParam('Short name shown in the board and the log.'),
          port: { type: 'integer', description: 'Port the process should listen on, when it has one.' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'process_logs',
      description: 'Read the captured output of a process started with start_process.',
      parameters: {
        type: 'object',
        properties: {
          id: stringParam('Process id returned by start_process, for example "proc_1a2b3c4d".'),
          lines: { type: 'integer', description: 'How many trailing lines to return (1-300). Defaults to 80.' },
        },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'stop_process',
      description: 'Stop a process started with start_process. Sends SIGTERM, then SIGKILL if it ignores it.',
      parameters: {
        type: 'object',
        properties: { id: stringParam('Process id returned by start_process.') },
        required: ['id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'port_status',
      description:
        'Check whether a port on this machine is listening, and which managed process owns it. Without a port, lists the managed processes.',
      parameters: {
        type: 'object',
        properties: { port: { type: 'integer', description: 'Port to check, for example 3000.' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_check',
      description:
        'Fetch a page from a server running on this machine and check it: status, content-type, the text the task expects, and the status of every same-origin script, stylesheet and image it references. Use this instead of hand-written fetch probes.',
      parameters: {
        type: 'object',
        properties: {
          url: stringParam('Loopback URL, for example "http://127.0.0.1:3000/".'),
          expect_text: stringParam('Copy that must appear in the HTML (case-insensitive).'),
          assets: {
            type: 'boolean',
            description: 'Check the assets the page references. Defaults to true.',
          },
        },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'revert_turn',
      description:
        'Undo every file change made during the current turn and restore the folder to how it was when the turn started. Use it when an edit made things worse instead of stacking repairs on top.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Run a shell command line inside the workspace. Pipes (|), redirects (> >> <, 2>, 2>&1, &>) and && / || / ; all work, so "echo hi > out.txt" and "npm test 2>&1 | tail -40" run as written. It is not sh -c: there is no $VAR expansion, no $(...), no globbing and no background &, and only allowlisted binaries run. Redirects may only target files inside the workspace.',
      parameters: {
        type: 'object',
        properties: {
          command: stringParam('The command line, for example "npm test 2>&1 | tail -40".'),
          max_lines: {
            type: 'integer',
            description: 'Keep only the first N lines of the final output (1-400).',
          },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'apply_patch',
      description:
        'Apply a unified diff (---/+++ headers and @@ hunks) to one or more files. The whole patch is checked before anything is written: if one hunk does not fit, nothing changes. Prefer this over edit_file for multi-line or multi-file changes, and for code you already know the line numbers of.',
      parameters: {
        type: 'object',
        properties: {
          patch: stringParam(
            'The diff itself, with --- and +++ file headers, @@ -a,b +c,d @@ hunk headers, and lines prefixed by space, - or +. Paths are relative to the workspace.',
          ),
          dry_run: {
            type: 'boolean',
            description: 'Only check that every hunk fits; write nothing.',
          },
        },
        required: ['patch'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_symbol',
      description:
        'Find where a function, class, interface, type or method is defined across the indexed files. Cheaper and more precise than searching raw text when you know the name.',
      parameters: {
        type: 'object',
        properties: {
          query: stringParam('Name or fragment, for example "buildCodeMap" or "resolve".'),
          kind: {
            type: 'string',
            enum: ['function', 'class', 'interface', 'type', 'enum', 'method', 'constant'],
            description: 'Restrict to one declaration kind.',
          },
          limit: { type: 'integer', description: 'How many matches to return (1-60, default 20).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_references',
      description:
        'List every place an identifier is mentioned, with the definition flagged. Use it before changing a shared name so you see all call sites.',
      parameters: {
        type: 'object',
        properties: {
          name: stringParam('The exact identifier, for example "emptyUsage".'),
          limit: { type: 'integer', description: 'How many mentions to return (1-100, default 40).' },
        },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_check',
      description:
        "Run the folder's own check script (check, typecheck, test, lint or build from package.json) and get the failing file:line entries back in one structured report. Use this instead of guessing the project's test command.",
      parameters: {
        type: 'object',
        properties: {
          name: stringParam('A specific npm script to run. Defaults to check, then typecheck, then test, then lint, then build.'),
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_media',
      description:
        'Attach an image (PNG, JPEG, WebP, GIF up to 4 MB) from the workspace so you can actually see it. Use it after preview_screenshot, or on a design reference the task points at — then describe what is wrong before changing code.',
      parameters: {
        type: 'object',
        properties: {
          path: stringParam('Image path relative to the workspace folder.'),
        },
        required: ['path'],
      },
    },
  },
];

/** Web tools — only offered when the operator enables outbound web access. */
const WEB_TOOLS: LlmTool[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the public web and return titles, URLs and snippets.',
      parameters: {
        type: 'object',
        properties: {
          query: stringParam('What to look for.'),
          results: { type: 'integer', description: 'How many results to return (1-10).' },
        },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch a public page and return its readable text.',
      parameters: {
        type: 'object',
        properties: { url: stringParam('Absolute http(s) URL.') },
        required: ['url'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'http_request',
      description:
        'Send an HTTP request to a local dev server or a public URL and return status, content type and body (JSON pretty-printed). Use it to verify an API you just wrote, not for reading articles.',
      parameters: {
        type: 'object',
        properties: {
          url: stringParam('Absolute http(s) URL. Loopback hosts are allowed; other hosts must resolve to a public address.'),
          method: {
            type: 'string',
            enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
            description: 'Defaults to GET.',
          },
          headers: {
            type: 'object',
            description: 'Request headers, for example {"content-type": "application/json"}.',
          },
          body: stringParam('Request body. Ignored for GET and HEAD.'),
          timeout_ms: { type: 'integer', description: 'Timeout in milliseconds (1000-60000, default 15000).' },
        },
        required: ['url'],
      },
    },
  },
];

export interface ToolAvailability {
  files: boolean;
  web: boolean;
  /**
   * Which slice of the toolkit to send. Defaults to `all`, which is what the
   * checks and any endpoint without a phase want; the runtime passes the
   * worker's current phase so a round pays for one phase slice instead of the
   * whole toolkit.
   */
  phase?: ToolPhase | 'all';
}

/** Builds the tool list for a session based on what the operator allowed. */
export function buildToolSchemas(availability: ToolAvailability): LlmTool[] {
  const schemas = [...OFFICE_TOOLS];
  if (availability.files) schemas.push(...FILE_TOOLS);
  if (availability.web) schemas.push(...WEB_TOOLS);

  const phase = availability.phase ?? 'all';
  if (phase === 'all') return schemas;
  const allowed = new Set(toolsForPhase(phase));
  return schemas.filter((tool) => allowed.has(tool.function.name));
}
