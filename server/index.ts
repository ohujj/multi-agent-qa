import express, { type Request, type Response, type NextFunction } from 'express';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { AGENT_IDS } from '../shared/types.js';
import { dataDir, port, redact } from './config.js';
import { Store } from './store.js';
import { Conflict, Manager } from './manager.js';
import { markdownReport } from './report.js';

const app = express();
const manager = new Manager(new Store(dataDir));
app.disable('x-powered-by');
app.use((req, res, next) => {
  // No CORS. Reject browser requests from other origins and DNS rebinding hosts.
  const hosts = ['127.0.0.1:' + port, 'localhost:' + port];
  if (!hosts.includes(req.headers.host || '')) return res.status(403).json({ error: '로컬 접속만 허용합니다.' });
  const origin = req.headers.origin;
  const origins = ['http://127.0.0.1:' + port, 'http://localhost:' + port];
  if (process.env.NODE_ENV !== 'production') origins.push('http://127.0.0.1:5173', 'http://localhost:5173');
  if (origin && !origins.includes(origin)) return res.status(403).json({ error: '허용되지 않은 요청 출처입니다.' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api', (req, res, next) => {
  if (['POST', 'PATCH', 'PUT'].includes(req.method) && !req.is('application/json')) return res.status(415).json({ error: 'JSON 요청만 허용합니다.' });
  next();
});
app.use(express.json({ limit: '64kb' }));
app.get('/api/state', (_req, res) => res.json(manager.state));
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  const update = () => res.write('data: ' + JSON.stringify(manager.state) + '\n\n');
  update();
  manager.on('change', update);
  const heartbeat = setInterval(() => res.write(': keepalive\n\n'), 15000);
  req.on('close', () => { clearInterval(heartbeat); manager.off('change', update); });
});
const settingsSchema = z.object({ targetUrl: z.string().url().max(2000), instructions: z.string().max(12000) });
const agentSchema = z.object({ role: z.string().max(4000), prompt: z.string().max(16000), accountLabel: z.string().max(100) });
const getId = (req: Request) => z.enum(AGENT_IDS).parse(req.params.id);
app.patch('/api/settings', (req, res) => { manager.updateSettings(settingsSchema.parse(req.body)); res.json(manager.state); });
app.patch('/api/agents/:id', (req, res) => { manager.updateAgent(getId(req), agentSchema.parse(req.body)); res.json(manager.state); });
app.post('/api/agents/:id/browser', (req, res) => { manager.openBrowser(getId(req)); res.json(manager.state); });
app.post('/api/agents/:id/run', (req, res) => { manager.run(getId(req)); res.status(202).json(manager.state); });
app.post('/api/agents/:id/pause', (req, res) => { manager.pause(getId(req)); res.json(manager.state); });
app.post('/api/agents/:id/resume', (req, res) => { manager.resume(getId(req)); res.json(manager.state); });
app.post('/api/agents/:id/stop', (req, res) => { manager.stop(getId(req)); res.status(202).json(manager.state); });
app.post('/api/tests/new', async (_req, res) => { await manager.newTest(); res.json(manager.state); });
app.patch('/api/findings/:id', (req, res) => {
  const finding = manager.state.findings.find(item => item.id === req.params.id);
  if (!finding) return res.status(404).json({ error: '기록이 없습니다.' });
  const { verification } = z.object({ verification: z.enum(['suspected', 'observed', 'reproduced']) }).parse(req.body);
  // Persist through the manager so all connected dashboards receive the new state.
  manager.verifyFinding(finding.id, verification);
  res.json(manager.state);
});
app.get('/api/artifacts/:file', (req, res) => {
  const file = String(req.params.file);
  if (!/^[a-f0-9-]{36}-[A-E]-[a-f0-9-]{36}\.(png|zip)$/.test(file)) return res.sendStatus(404);
  const fullPath = path.join(dataDir, 'artifacts', file);
  if (!existsSync(fullPath)) return res.sendStatus(404);
  if (file.endsWith('.zip')) return res.download(fullPath, file, { dotfiles: 'allow' });
  res.type('png').sendFile(fullPath, { dotfiles: 'allow' });
});
app.get('/api/report', (req, res) => {
  const json = req.query.format === 'json';
  res.setHeader('Content-Disposition', 'attachment; filename="agent-qa-' + manager.state.testId.slice(0, 8) + (json ? '.json"' : '.md"'));
  res.type(json ? 'application/json' : 'text/markdown').send(json ? JSON.stringify(manager.state, null, 2) : markdownReport(manager.state));
});
app.use('/api', (_req, res) => res.status(404).json({ error: '지원하지 않는 API입니다.' }));
const webDir = fileURLToPath(new URL('../web', import.meta.url));
if (existsSync(webDir)) {
  app.use(express.static(webDir));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(webDir, 'index.html')));
}
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = error instanceof Conflict ? 409 : error instanceof z.ZodError ? 400 : 500;
  res.status(status).json({ error: redact(error instanceof z.ZodError ? error.issues.map(issue => issue.message).join(', ') : String(error instanceof Error ? error.message : error)) });
});
const server = app.listen(port, '127.0.0.1', () => console.log('Agent QA: http://127.0.0.1:' + port));
let exiting = false;
async function shutdown() {
  if (exiting) return; exiting = true;
  server.close();
  await manager.shutdown();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
