import 'dotenv/config';
import path from 'node:path';
process.env.PLAYWRIGHT_BROWSERS_PATH ||= path.resolve('.local/browsers');
export const dataDir = path.resolve(process.env.QA_DATA_DIR || '.local');
export const port = Number(process.env.PORT || 4310);
export const maxTurns = Math.min(100, Math.max(1, Number(process.env.MAX_TURNS) || 25));
export const timeoutSeconds = Math.min(1800, Math.max(10, Number(process.env.RUN_TIMEOUT_SECONDS) || 180));
export const configured = () => Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_MODEL);
export function redact(value: string): string {
  let result = value;
  if (process.env.OPENAI_API_KEY) result = result.split(process.env.OPENAI_API_KEY).join('[REDACTED]');
  return result.replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:access_token|refresh_token|id_token|api_key|password|secret|authorization)[=:]\s*)[^\s&"']+/gi, '$1[REDACTED]')
    .replace(/sk-[a-zA-Z0-9_-]{16,}/g, '[REDACTED]');
}
export function targetUrl(value: string): string {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('HTTP(S) 주소만 사용할 수 있습니다.');
  return url.href;
}
