import { EventEmitter } from 'node:events';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { AGENT_IDS, type AgentId, type Dashboard, type AgentView, type Settings, type FeedbackContext } from '../shared/types.js';
import { configured, maxTurns, redact, targetUrl, timeoutSeconds, feedbackTimeoutSeconds } from './config.js';
import type { ParentCommand, WorkerEvent } from './protocol.js';
import type { Store } from './store.js';
import { BadRequest, Conflict } from './errors.js';
import { workerEnvironment } from './environment.js';
import { recordedFeedback } from './feedback.js';
export { Conflict } from './errors.js';

type WorkerHandle = { process: ChildProcess; runId: string | null; finishing?: boolean; timer?: ReturnType<typeof setTimeout>; stopTimer?: ReturnType<typeof setTimeout> };
const now = () => new Date().toISOString();
function fresh(settings?: Settings, previous?: AgentView[]): Dashboard {
  return {
    testId: randomUUID(), startedAt: now(), activeAgent: null,
    settings: settings || { captureMode: 'off', targetUrl: 'https://moyeo-web.vercel.app/login', instructions: '허용된 테스트 계정과 데이터만 사용하세요. 위험한 작업은 수행하지 말고 근거와 함께 보고하세요.' },
    agents: AGENT_IDS.map(id => {
      const old = previous?.find(agent => agent.id === id);
      return { id, name: 'Agent ' + id, role: old?.role || '', prompt: old?.prompt || '', accountLabel: old?.accountLabel || '', status: 'idle', action: '실행을 기다리고 있어요', browserOpen: false, history: [], screenshot: null };
    }),
    findings: [], events: [], configured: configured(), model: process.env.OPENAI_MODEL || '', maxTurns, timeoutSeconds,
  };
}
export class Manager extends EventEmitter {
  state: Dashboard;
  private workers = new Map<AgentId, WorkerHandle>();
  private sequence = 0;
  private resetting = false;
  constructor(private store: Store) {
    super();
    this.state = store.latest() || fresh();
    this.state.settings.captureMode ||= 'off';
    this.sequence = Math.max(0, ...this.state.events.map(event => event.id));
    this.state.configured = configured();
    this.state.model = process.env.OPENAI_MODEL || '';
    this.state.maxTurns = maxTurns;
    this.state.timeoutSeconds = timeoutSeconds;
    const interrupted = this.state.activeAgent;
    this.state.activeAgent = null;
    for (const agent of this.state.agents) {
      agent.browserOpen = false;
      if (['running', 'pausing', 'paused', 'summarizing', 'stopping'].includes(agent.status)) {
        agent.status = 'cancelled';
        agent.action = '서버가 재시작되었습니다. 서비스에 반영된 결과를 확인하세요.';
      }
    }
    if (interrupted) this.event(interrupted, 'interrupted', '서버 재시작으로 중단되었습니다. 마지막 요청의 반영 여부는 확인이 필요합니다.');
    this.publish();
  }
  private agent(id: AgentId) {
    const agent = this.state.agents.find(item => item.id === id);
    if (!agent) throw new Error('존재하지 않는 에이전트입니다.');
    return agent;
  }
  private idle() {
    if (this.resetting || this.state.activeAgent) throw new Conflict('다른 작업이 진행 중입니다. 완료 또는 중단 후 실행하세요.');
  }
  private publish() { this.store.save(this.state); this.emit('change', this.state); }
  private event(agentId: AgentId | null, kind: string, message: string, source: 'system' | 'agent' = 'system', createdAt = now()) {
    this.state.events.push({ id: ++this.sequence, agentId, kind, message: redact(message), source, createdAt });
    this.state.events = this.state.events.slice(-1000);
  }
  updateSettings(settings: Settings) {
    this.idle();
    const normalized = targetUrl(settings.targetUrl);
    if (normalized !== this.state.settings.targetUrl && this.workers.size) throw new Conflict('대상 주소를 바꾸려면 브라우저를 닫는 새 테스트를 먼저 시작하세요.');
    this.state.settings = { targetUrl: normalized, instructions: redact(settings.instructions), captureMode: settings.captureMode };
    if (settings.captureMode === 'off') for (const agent of this.state.agents) agent.screenshot = null;
    this.publish();
  }
  updateAgent(id: AgentId, patch: Pick<AgentView, 'role' | 'prompt' | 'accountLabel'>) {
    const agent = this.agent(id);
    if (this.resetting || this.state.activeAgent === id) throw new Conflict('실행 중인 에이전트 설정은 수정할 수 없습니다.');
    Object.assign(agent, { role: redact(patch.role), prompt: redact(patch.prompt), accountLabel: redact(patch.accountLabel) });
    this.publish();
  }
  private worker(id: AgentId): WorkerHandle {
    let handle = this.workers.get(id);
    if (handle) return handle;
    const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js';
    const child = fork(new URL('./worker.' + extension, import.meta.url), [], {
      execArgv: extension === 'ts' ? ['--import', 'tsx'] : [],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: workerEnvironment(),
    });
    handle = { process: child, runId: null };
    this.workers.set(id, handle);
    const identity = handle;
    child.on('message', (event: WorkerEvent) => {
      if (this.workers.get(id) !== identity) return;
      const agent = this.agent(id);
      if (event.type === 'ready') agent.browserOpen = event.browserOpen;
      if (event.type === 'status' && (!identity.finishing || event.status === 'summarizing' || event.status === 'stopping')) { agent.status = event.status; agent.action = redact(event.action); }
      if (event.type === 'progress') { agent.action = redact(event.message); this.event(id, event.kind, event.message, event.source, event.createdAt); }
      if (event.type === 'action') { agent.action = redact(event.message); this.event(id, 'action', event.message); }
      if (event.type === 'screenshot') agent.screenshot = event.file;
      if (event.type === 'finding') { this.state.findings.push(event.finding); this.event(id, 'finding', event.finding.title); }
      if (event.type === 'done' && identity.runId && !(identity.finishing && event.status === 'waiting')) {
        clearTimeout(identity.timer); clearTimeout(identity.stopTimer);
        identity.runId = null; identity.finishing = false;
        agent.status = event.status;
        agent.action = event.status === 'waiting' ? '작업 완료 · 종료하고 피드백을 받을 수 있어요' : event.status === 'completed' ? '피드백 정리 완료' : '실행 실패';
        agent.history.push({ role: 'assistant', text: redact(event.output), createdAt: now() });
        this.state.activeAgent = null;
        this.event(id, event.status, event.output, event.source);
      }
      this.publish();
    });
    child.on('error', error => { this.event(id, 'error', error.message); this.publish(); });
    child.on('exit', () => {
      if (this.workers.get(id) !== identity) return;
      clearTimeout(identity.timer); clearTimeout(identity.stopTimer);
      this.workers.delete(id);
      const agent = this.agent(id);
      agent.browserOpen = false;
      if (identity.runId) {
        agent.status = 'cancelled';
        agent.action = '작업 프로세스 종료 · 마지막 요청 결과 확인 필요';
        const output = identity.finishing ? recordedFeedback(this.feedbackContext(id), 'AI 정리 시간 초과 또는 프로세스 종료로 기록만 정리했습니다.') : agent.action;
        agent.history.push({ role: 'assistant', text: output, createdAt: now() });
        this.state.activeAgent = null;
        this.event(id, 'cancelled', agent.action);
      }
      this.publish();
    });
    return handle;
  }
  private send(handle: WorkerHandle, message: ParentCommand) { handle.process.send(message); }
  openBrowser(id: AgentId) {
    this.idle();
    const agent = this.agent(id);
    const handle = this.worker(id);
    this.send(handle, { type: 'open', testId: this.state.testId, agentId: id, settings: this.state.settings });
    this.event(id, 'browser', '전용 브라우저 열기 · 계정 로그인은 브라우저에서 직접 진행하세요.');
    agent.action = '브라우저 준비 중';
    this.publish();
  }
  run(id: AgentId) {
    this.idle();
    if (!configured()) throw new Conflict('.env에 OPENAI_API_KEY와 OPENAI_MODEL을 설정한 뒤 서버를 재시작하세요.');
    const agent = this.agent(id);
    if (!agent.prompt.trim()) throw new BadRequest('실행할 프롬프트를 입력하세요.');
    const handle = this.worker(id);
    // Acquire synchronously before sending IPC; a second HTTP request cannot queue another run.
    this.state.activeAgent = id;
    agent.status = 'running';
    handle.finishing = false;
    agent.action = '실행 준비 중';
    const history = [...agent.history];
    agent.history.push({ role: 'user', text: redact(agent.prompt), createdAt: now() });
    handle.runId = randomUUID();
    this.event(id, 'started', '사용자 실행 요청');
    handle.timer = setTimeout(() => this.stop(id, '실행 시간 제한에 도달했습니다.'), timeoutSeconds * 1000);
    this.publish();
    this.send(handle, { type: 'run', testId: this.state.testId, agentId: id, settings: this.state.settings, role: agent.role, prompt: agent.prompt, history, runId: handle.runId });
  }
  pause(id: AgentId) {
    if (this.state.activeAgent !== id || this.agent(id).status !== 'running') throw new Conflict('실행 중인 에이전트만 일시정지할 수 있습니다.');
    this.agent(id).status = 'pausing';
    this.agent(id).action = '현재 액션이 끝나면 일시정지합니다';
    this.send(this.workers.get(id)!, { type: 'pause' });
    this.publish();
  }
  resume(id: AgentId) {
    if (this.state.activeAgent !== id || !['paused', 'pausing'].includes(this.agent(id).status)) throw new Conflict('일시정지 상태가 아닙니다.');
    this.send(this.workers.get(id)!, { type: 'resume' });
    this.agent(id).status = 'running';
    this.publish();
  }
  stop(id: AgentId, reason = '사용자가 중단했습니다.') {
    const handle = this.workers.get(id);
    if (this.state.activeAgent !== id || !handle?.runId) throw new Conflict('실행 중인 에이전트가 아닙니다.');
    if (this.agent(id).status === 'stopping') return;
    this.agent(id).status = 'stopping';
    this.agent(id).action = reason;
    this.event(id, 'stopping', reason);
    handle.finishing = false;
    this.send(handle, { type: 'stop' });
    // Keep the serial lock until the child has exited. In-flight service requests may still commit.
    handle.stopTimer = setTimeout(() => handle.process.kill('SIGKILL'), 3000);
    this.publish();
  }
  private feedbackContext(id: AgentId): FeedbackContext {
    const agent = this.agent(id);
    return { agentId: id, targetUrl: this.state.settings.targetUrl, role: agent.role,
      history: [...agent.history], events: this.state.events.filter(event => event.agentId === id),
      findings: this.state.findings.filter(finding => finding.agentId === id) };
  }
  finish(id: AgentId) {
    if (this.resetting || (this.state.activeAgent && this.state.activeAgent !== id)) throw new Conflict('다른 작업이 진행 중입니다.');
    const agent = this.agent(id);
    if (['summarizing', 'stopping'].includes(agent.status)) throw new Conflict('종료 처리가 진행 중입니다.');
    if (agent.status === 'completed') throw new Conflict('이미 최종 피드백을 정리했습니다.');
    if (!agent.history.length) throw new BadRequest('정리할 실행 기록이 없습니다.');
    const handle = this.worker(id);
    clearTimeout(handle.timer); clearTimeout(handle.stopTimer);
    handle.finishing = true;
    handle.runId ||= randomUUID();
    this.state.activeAgent = id;
    agent.status = 'summarizing';
    agent.action = '브라우저 조작을 종료하고 피드백을 정리합니다';
    this.event(id, 'feedback', agent.action);
    // Allow an in-flight browser action to settle, then a bounded summary request.
    handle.stopTimer = setTimeout(() => handle.process.kill('SIGKILL'), (feedbackTimeoutSeconds + 30) * 1000);
    this.publish();
    this.send(handle, { type: 'finish', context: this.feedbackContext(id) });
  }
  verifyFinding(id: string, verification: 'suspected' | 'observed' | 'reproduced') {
    const finding = this.state.findings.find(item => item.id === id);
    if (!finding) throw new Error('기록이 없습니다.');
    finding.verification = verification;
    this.event(finding.agentId, 'verification', '사용자 검증 상태 변경: ' + finding.title + ' · ' + verification);
    this.publish();
  }
  async newTest() {
    this.idle(); this.resetting = true;
    try {
      await this.closeWorkers();
      const previous = this.state;
      this.state = fresh(previous.settings, previous.agents);
      this.event(null, 'new-test', '새 테스트 시작 · 5명 대화 초기화 · 로그인 프로필은 유지');
      this.publish();
    } finally { this.resetting = false; }
  }
  private async closeWorkers() {
    const handles = [...this.workers.values()];
    await Promise.all(handles.map(handle => new Promise<void>(resolve => {
      const timer = setTimeout(() => handle.process.kill('SIGKILL'), 3000);
      handle.process.once('exit', () => { clearTimeout(timer); resolve(); });
      this.send(handle, { type: 'close' });
    })));
    this.workers.clear();
  }
  async shutdown() { await this.closeWorkers(); this.store.close(); }
}
