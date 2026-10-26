// Explicit process boundaries: Chromium does not need model credentials.
const osVariables = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC',
  'TEMP', 'TMP', 'TMPDIR', 'USERPROFILE', 'HOME', 'USERNAME', 'APPDATA', 'LOCALAPPDATA',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMDATA', 'ALLUSERSPROFILE',
  'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR',
  'LANG', 'LC_ALL', 'TZ',
]);
export function browserEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && osVariables.has(key.toUpperCase())));
}
export function workerEnvironment(): NodeJS.ProcessEnv {
  const result = browserEnvironment();
  for (const key of ['OPENAI_API_KEY', 'OPENAI_MODEL', 'OPENAI_BASE_URL', 'QA_DATA_DIR', 'HEADLESS',
    'PLAYWRIGHT_BROWSERS_PATH', 'MAX_TURNS', 'RUN_TIMEOUT_SECONDS', 'FEEDBACK_TIMEOUT_SECONDS']) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  // A worker must not reload unrelated secrets from the parent's .env file.
  result.QA_WORKER = '1';
  result.OPENAI_AGENTS_DISABLE_TRACING = '1';
  return result;
}
