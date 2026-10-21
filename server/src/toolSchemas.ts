import type { LlmTool } from './llm.ts';

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
        properties: { summary: stringParam('What was delivered and the result.') },
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
      name: 'run_command',
      description:
        'Run one read-oriented shell command inside the workspace. One command per call, no pipes or chaining.',
      parameters: {
        type: 'object',
        properties: { command: stringParam('A single command, for example "ls -la".') },
        required: ['command'],
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
];

export interface ToolAvailability {
  files: boolean;
  web: boolean;
}

/** Builds the tool list for a session based on what the operator allowed. */
export function buildToolSchemas(availability: ToolAvailability): LlmTool[] {
  const schemas = [...OFFICE_TOOLS];
  if (availability.files) schemas.push(...FILE_TOOLS);
  if (availability.web) schemas.push(...WEB_TOOLS);
  return schemas;
}
