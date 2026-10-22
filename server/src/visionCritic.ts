import { chat, type LlmMessage, type LlmSettings, type LlmUsage } from './llm.ts';

/**
 * The visual critic.
 *
 * The reviewer reads a diff and can miss a page that technically works and
 * looks broken: overlapping text, a header pushed off-screen, an empty hero.
 * `read_media` gives the model the image; this pass makes the judgement
 * independent of the worker that produced it, and returns something the runtime
 * can refuse.
 *
 * It shares the reviewer's contract on purpose: a reply that cannot be parsed is
 * `null`, never a pass, and a refusal with no issue is unusable.
 */

export interface VisionInput {
  taskTitle: string;
  /** What the image is: a screenshot of the page, or a reference the task named. */
  source: string;
  imageDataUrl: string;
}

export interface VisionVerdict {
  verdict: 'pass' | 'fail';
  issues: string[];
  usage?: LlmUsage;
}

const MAX_ISSUES = 5;
const MAX_ISSUE_CHARS = 240;

export function buildVisionMessages(input: VisionInput): LlmMessage[] {
  return [
    {
      role: 'system',
      content: [
        'You are the visual critic for a finished UI task. You did not build this page.',
        'Look at the attached image and judge what a person would see: layout, spacing, alignment,',
        'clipped or overlapping text, unreadable contrast, missing sections the task asked for,',
        'content that is obviously placeholder. Ignore taste you cannot defend from the image.',
        'Reply with exactly one JSON object and nothing else:',
        '{"verdict":"pass"|"fail","issues":["one concrete problem visible in the image"]}',
      ].join(' '),
    },
    {
      role: 'user',
      content: [
        `Task: ${input.taskTitle}`,
        `Image: ${input.source}`,
        'Judge the image above. If it is a reference rather than the built page, say so as a failure.',
      ].join('\n'),
      images: [input.imageDataUrl],
    },
  ];
}

/** Same discipline as the code reviewer: unreadable is not a pass. */
export function parseVision(raw: string): VisionVerdict | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const verdict = (parsed as { verdict?: unknown }).verdict;
  if (verdict !== 'pass' && verdict !== 'fail') return null;

  const rawIssues = (parsed as { issues?: unknown }).issues;
  const issues = (Array.isArray(rawIssues) ? rawIssues : [])
    .filter((issue): issue is string => typeof issue === 'string')
    .map((issue) => issue.replace(/\s+/g, ' ').trim().slice(0, MAX_ISSUE_CHARS))
    .filter((issue) => issue.length > 0)
    .slice(0, MAX_ISSUES);

  if (verdict === 'fail' && issues.length === 0) return null;
  return { verdict, issues };
}

/** One critic call. Throws on transport errors; the caller decides what that means. */
export async function critiqueImage(settings: LlmSettings, input: VisionInput): Promise<VisionVerdict | null> {
  const result = await chat(settings, buildVisionMessages(input));
  const parsed = parseVision(result.content);
  return parsed ? { ...parsed, usage: result.usage } : null;
}
