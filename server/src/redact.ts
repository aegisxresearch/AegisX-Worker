/**
 * Secrets do not belong in a model context, a log line or a bug report.
 *
 * A worker reads a file, the file turns out to be `.env`, and the key is now in
 * the transcript — which the operator pastes into an issue. The path guard does
 * not help: the file *is* inside the folder. So anything leaving a tool is
 * filtered here, before it reaches the model or the activity log.
 *
 * The shapes below are the ones that actually leak: provider keys, cloud keys,
 * private key blocks, and `TOKEN=…` assignments. High-entropy strings catch the
 * rest without matching ordinary prose.
 */

const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;
const ASSIGNMENT =
  /^(\s*(?:export\s+)?[A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_KEY|APIKEY|PRIVATE|ACCESS_KEY|CLIENT_SECRET)[A-Z0-9_]*\s*[=:]\s*)(["']?)([^\s"'#]{6,})\2/gim;
const PROVIDER_KEY = /\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g;
const GITHUB_TOKEN = /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g;
const AWS_KEY = /\bAKIA[0-9A-Z]{16}\b/g;
const SLACK_TOKEN = /\bxox[abpsr]-[A-Za-z0-9-]{10,}\b/g;
const BEARER = /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g;
const HIGH_ENTROPY = /\b[A-Za-z0-9+/=_-]{24,}\b/g;

/** Shannon entropy per character; prose sits near 4, keys sit above 4.5. */
function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);
  let total = 0;
  for (const count of counts.values()) {
    const probability = count / value.length;
    total -= probability * Math.log2(probability);
  }
  return total;
}

/** A marker that keeps the shape (so a test can name it) without the value. */
function marker(label: string, value: string): string {
  return `[redacted ${label}, ${value.length} chars]`;
}

/**
 * Replaces every secret-shaped span. Idempotent: running it twice changes
 * nothing, so it is safe to apply at several boundaries.
 */
export function redactSecrets(text: string): string {
  if (text.length === 0) return text;
  let output = text;

  output = output.replace(PRIVATE_KEY_BLOCK, '[redacted private key block]');
  output = output.replace(
    ASSIGNMENT,
    (_match, prefix: string, quote: string, value: string) =>
      `${prefix}${quote}${marker('value', value)}${quote}`,
  );
  output = output.replace(PROVIDER_KEY, (match) => marker('key', match));
  output = output.replace(GITHUB_TOKEN, (match) => marker('github token', match));
  output = output.replace(AWS_KEY, (match) => marker('aws key', match));
  output = output.replace(SLACK_TOKEN, (match) => marker('slack token', match));
  output = output.replace(BEARER, (_match, prefix: string) => `${prefix}[redacted token]`);

  // Only strings no human would type: a base64 blob or a random id.
  output = output.replace(HIGH_ENTROPY, (match) => {
    if (!/[A-Za-z]/.test(match) || !/[0-9]/.test(match)) return match;
    if (match.startsWith('[redacted')) return match;
    return entropy(match) > 4.5 ? marker('string', match) : match;
  });

  return output;
}

/** True when the text contains something the filter would change. */
export function containsSecret(text: string): boolean {
  return redactSecrets(text) !== text;
}
