import { useEffect, useRef, useState } from 'react';
import type { AgentId, AgentStatus, Dashboard, Finding } from '../shared/types';

const statusLabel: Record<AgentStatus, string> = { idle: '대기', running: '실행 중', pausing: '정지 중', paused: '일시정지', stopping: '중단 중', completed: '완료', failed: '실패', cancelled: '중단됨' };
const categoryLabel = { bug: '버그', security: '보안', ux: 'UX 개선', idea: '아이디어' };
const verificationLabel = { suspected: '미확인', observed: '관찰됨', reproduced: '사용자 재현 확인' };
type Page = 'workspace' | 'findings' | 'settings';
async function api(path: string, method = 'GET', body?: unknown): Promise<Dashboard> {
  const response = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '요청을 처리하지 못했습니다.');
  return data;
}
function clock(value: string) { return new Date(value).toLocaleTimeString('ko-KR', { hour12: false }); }
function hostname(value: string) { try { return new URL(value).hostname; } catch { return value; } }
export function App() {
  const [state, setState] = useState<Dashboard>();
  const [connected, setConnected] = useState(false);
  const [selected, setSelected] = useState<AgentId>('A');
  const [page, setPage] = useState<Page>('workspace');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [resetDialog, setResetDialog] = useState(false);
  const [tab, setTab] = useState<'result' | 'activity'>('result');
  const [filter, setFilter] = useState('all');
  const [draft, setDraft] = useState({ role: '', prompt: '', accountLabel: '' });
  const [settings, setSettings] = useState({ targetUrl: '', instructions: '' });
  const draftKey = useRef('');
  useEffect(() => {
    const events = new EventSource('/api/events');
    events.onmessage = event => { setState(JSON.parse(event.data)); setConnected(true); };
    events.onerror = () => setConnected(false);
    return () => events.close();
  }, []);
  const agent = state?.agents.find(item => item.id === selected);
  useEffect(() => {
    if (!state || !agent) return;
    const key = state.testId + ':' + selected;
    if (draftKey.current !== key) {
      draftKey.current = key;
      setDraft({ role: agent.role, prompt: agent.prompt, accountLabel: agent.accountLabel });
    }
  }, [state, agent, selected]);
  useEffect(() => { if (state) setSettings(state.settings); }, [state?.testId]);
  async function perform(action: () => Promise<Dashboard>) {
    setBusy(true); setError('');
    try { const next = await action(); setState(next); return next; }
    catch (error) { setError(String(error instanceof Error ? error.message : error)); }
    finally { setBusy(false); }
  }
  async function saveAgent() { return api('/agents/' + selected, 'PATCH', draft); }
  async function selectAgent(id: AgentId) {
    if (id === selected || busy) return;
    const dirty = agent && (draft.role !== agent.role || draft.prompt !== agent.prompt || draft.accountLabel !== agent.accountLabel);
    if (dirty) {
      const next = await perform(saveAgent);
      if (!next) return;
    }
    setSelected(id); setTab('result');
  }
  if (!state || !agent) return <div className="loading"><span className="brand-mark">a<span>·</span></span><h2>워크스페이스 연결 중</h2><p>로컬 QA 서버를 확인하고 있어요.</p></div>;
  const active = state.activeAgent !== null;
  const isSelectedActive = state.activeAgent === selected;
  const editingDisabled = busy || isSelectedActive || !connected;
  const visibleFindings = state.findings.filter(finding => filter === 'all' || finding.category === filter);
  const selectedFindings = state.findings.filter(finding => finding.agentId === selected);
  const agentEvents = state.events.filter(event => event.agentId === selected);
  const currentOutput = [...agent.history].reverse().find(message => message.role === 'assistant');
  const completed = state.agents.filter(item => item.status === 'completed').length;
  const patchDraft = (key: keyof typeof draft, value: string) => setDraft(previous => ({ ...previous, [key]: value }));
  const command = (name: string) => perform(() => api('/agents/' + selected + '/' + name, 'POST', {}));
  const runAgent = () => perform(async () => { await saveAgent(); return api('/agents/' + selected + '/run', 'POST', {}); });
  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#" onClick={event => { event.preventDefault(); setPage('workspace'); }}><span className="brand-mark">a<span>·</span></span><span>agent<span className="brand-light">qa</span><small>LOCAL TESTING STUDIO</small></span></a>
      <div className="workspace-label"><span className="workspace-avatar">M</span><div>My workspace<small>개인 워크스페이스</small></div><span className="subtle">⌄</span></div>
      <div className="nav-caption">WORKSPACE</div>
      <nav aria-label="주 메뉴">
        <button className={page === 'workspace' ? 'nav-item selected' : 'nav-item'} onClick={() => setPage('workspace')}><span>▦</span>테스트 스튜디오</button>
        <button className={page === 'findings' ? 'nav-item selected' : 'nav-item'} onClick={() => setPage('findings')}><span>◈</span>발견 사항<span className="nav-count">{state.findings.length}</span></button>
        <button className={page === 'settings' ? 'nav-item selected' : 'nav-item'} onClick={() => setPage('settings')}><span>⚙</span>테스트 설정</button>
      </nav>
      <div className="sidebar-agents"><div className="nav-caption">YOUR AGENTS <span>05</span></div>{state.agents.map(item => <button key={item.id} className={'mini-agent ' + (item.id === selected && page === 'workspace' ? 'chosen' : '')} onClick={async () => { await selectAgent(item.id); setPage('workspace'); }}><span className={'mini-avatar agent-' + item.id}>{item.id}</span><span>{item.name}</span><i className={'status-dot ' + item.status}/></button>)}</div>
      <div className="local-note"><span className="local-icon">⌘</span><strong>내 PC에서 실행 중</strong><p>독립된 브라우저에서<br/>한 번에 한 에이전트씩.</p><span className="local-badge">LOCAL FIRST</span></div>
      <div className="sidebar-bottom"><span className={'connection-dot ' + (connected ? 'online' : '')}/>{connected ? '로컬 서버 연결됨' : '재연결 중…'}<span>v0.1</span></div>
    </aside>
    <div className="main-shell">
      <header className="topbar"><div><span className="subtle">워크스페이스</span><span className="breadcrumb">/</span><strong>{page === 'workspace' ? '테스트 스튜디오' : page === 'findings' ? '발견 사항' : '테스트 설정'}</strong></div><div className="topbar-right"><span className="mode-pill"><i/>직렬 실행 모드</span><span className="user-avatar">M</span></div></header>
      <main>
        <div className="page-heading"><div><div className="eyebrow">YOUR AGENTS, YOUR SCENARIOS</div><h1>{page === 'workspace' ? '테스트 스튜디오' : page === 'findings' ? '발견 사항' : '테스트 설정'}<span className="heading-dot">.</span></h1><p>{page === 'workspace' ? '역할을 정하고, 프롬프트를 입력하고, 준비된 에이전트를 실행하세요.' : page === 'findings' ? '에이전트의 관찰을 모으고, 근거와 재현 여부를 확인하세요.' : '테스트 대상과 모든 에이전트에 적용할 공통 지침을 관리하세요.'}</p></div><button className="button secondary" onClick={() => setResetDialog(true)} disabled={active || busy || !connected}><span>↻</span>새 테스트</button></div>
        {error && <div className="alert error" role="alert"><span>{error}</span><button aria-label="오류 닫기" onClick={() => setError('')}>×</button></div>}
        {!connected && <div className="alert error">서버와 연결이 끊겼습니다. 재연결될 때까지 실행 제어를 사용할 수 없습니다.</div>}
        {!state.configured && <div className="alert setup"><span className="setup-symbol">i</span><div><strong>AI 연결을 준비해 주세요</strong><span>로컬 .env에 OPENAI_API_KEY와 OPENAI_MODEL을 설정하고 서버를 재시작하세요. 브라우저 로그인은 먼저 준비할 수 있어요.</span></div><button onClick={() => setPage('settings')}>설정 안내 ↗</button></div>}
        <section className="summary-bar" aria-label="테스트 요약"><div className="target-summary"><span className="target-symbol">◎</span><div><span className="meta-label">테스트 대상</span><strong>{hostname(state.settings.targetUrl)}</strong></div><a href={state.settings.targetUrl} target="_blank" rel="noreferrer" aria-label="테스트 대상 열기">↗</a></div><div><span className="meta-label">에이전트</span><strong>5 <small>명</small></strong></div><div><span className="meta-label">실행 완료</span><strong>{completed} <small>/ 5</small></strong></div><div><span className="meta-label">발견 사항</span><strong>{state.findings.length} <small>건</small></strong></div><div className="test-id"><span className="meta-label">TEST SESSION</span><code>#{state.testId.slice(0, 8)}</code></div></section>
        {page === 'workspace' && <>
          <div className="section-heading"><h2>에이전트 워크스페이스 <span>05</span></h2><span className="subtle">{active ? 'Agent ' + state.activeAgent + ' 작업 중 · 다른 에이전트는 대기합니다' : '실행할 에이전트를 선택하세요'}</span></div>
          <div className="agent-grid">{state.agents.map(item => <button key={item.id} className={'agent-card ' + (selected === item.id ? 'active' : '')} onClick={() => void selectAgent(item.id)} disabled={busy}><div className="agent-card-top"><span className={'agent-avatar agent-' + item.id}>{item.id}</span><span className={'status-label ' + item.status}><i className={'status-dot ' + item.status}/>{statusLabel[item.status]}</span></div><strong>{item.name}</strong><span className="agent-role">{item.role || '자유롭게 역할을 설정하세요'}</span><div className="agent-card-footer"><span>{item.accountLabel || '계정 별칭 미설정'}</span><span>{item.browserOpen ? '● 연결됨' : '○ 브라우저 닫힘'}</span></div></button>)}</div>
          <div className="work-grid">
            <section className="panel prompt-panel"><div className="panel-heading"><div className="panel-title"><span className={'small-avatar agent-' + selected}>{selected}</span><h2>{agent.name}</h2><span className="tag">개별 컨텍스트</span></div><span className="subtle">수동 실행</span></div>
              <div className="prompt-form">
                <div className="form-row"><label>역할<input value={draft.role} onChange={event => patchDraft('role', event.target.value)} placeholder="예: 처음 방문한 모임 참여자" disabled={editingDisabled} maxLength={4000}/></label><label>계정 별칭<input value={draft.accountLabel} onChange={event => patchDraft('accountLabel', event.target.value)} placeholder="예: 테스트 계정 01" disabled={editingDisabled} maxLength={100}/></label></div>
                <label className="prompt-label">이번에 수행할 작업<span>프롬프트</span><textarea aria-label="실행 프롬프트" value={draft.prompt} onChange={event => patchDraft('prompt', event.target.value)} placeholder={'어떤 작업을 수행할까요?\n\n예: 새로운 모임을 만들고 초대 링크를 알려줘.\n참여자가 이해하기 어려운 화면이 있다면 근거와 함께 기록해 줘.'} disabled={editingDisabled} maxLength={16000}/></label>
                <div className="prompt-hint"><span>↳</span> 같은 테스트에서는 이 에이전트의 이전 대화를 기억합니다.</div>
                <div className="prompt-actions"><button className="button secondary small" onClick={() => void perform(saveAgent)} disabled={editingDisabled}>설정 저장</button><div>{isSelectedActive ? <><button className="button secondary" disabled={busy || !connected || agent.status === 'stopping'} onClick={() => void command(agent.status === 'paused' || agent.status === 'pausing' ? 'resume' : 'pause')}>{agent.status === 'paused' || agent.status === 'pausing' ? '▷ 재개' : 'Ⅱ 일시정지'}</button><button className="button danger" disabled={busy || !connected || agent.status === 'stopping'} onClick={() => void command('stop')}>■ 중단</button></> : <button className="button primary" disabled={busy || active || !draft.prompt.trim() || !state.configured || !connected} onClick={() => void runAgent()}><span>▶</span>{agent.name} 실행</button>}</div></div>
              </div>
            </section>
            <section className="panel browser-panel"><div className="panel-heading"><div className="panel-title"><span>▣</span><h2>브라우저 미리보기</h2></div><button className="text-button" onClick={() => void command('browser')} disabled={busy || active || !connected}>{agent.browserOpen ? '브라우저 보기 ↗' : '브라우저 열기 ↗'}</button></div><div className="browser-chrome"><span/><span/><span/><code>{hostname(state.settings.targetUrl)}</code><span className="browser-isolation">격리된 세션</span></div><div className="browser-screen">{agent.screenshot ? <a href={'/api/artifacts/' + agent.screenshot} target="_blank" rel="noreferrer"><img src={'/api/artifacts/' + agent.screenshot} alt={agent.name + ' 최근 브라우저 화면'}/></a> : <div className="empty-browser"><div className="browser-illustration"><span>⌁</span><i/><i/><i/></div><strong>에이전트의 시선으로 확인하세요</strong><p>전용 브라우저를 열어 직접 로그인하세요.<br/>실행 시 최신 화면이 이곳에 표시됩니다.</p><button className="button secondary small" onClick={() => void command('browser')} disabled={busy || active || !connected}>전용 브라우저 열기 ↗</button></div>}</div><div className="browser-footer"><span className={agent.browserOpen ? 'green-text' : 'subtle'}>● {agent.browserOpen ? '브라우저 연결됨' : '브라우저 대기 중'}</span><span>입력값 마스킹 · 액션 후 화면 갱신</span></div></section>
          </div>
          <section className="panel results-panel"><div className="result-tabs"><div><button className={tab === 'result' ? 'active' : ''} onClick={() => setTab('result')}>실행 결과 <span>{agent.history.filter(message => message.role === 'assistant').length}</span></button><button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}>활동 로그 <span>{agentEvents.length}</span></button></div><span className="current-action"><i className={'status-dot ' + agent.status}/>{agent.action}</span></div>
            {tab === 'result' ? <div className="result-body">{currentOutput ? <><div className="result-meta"><span className={'small-avatar agent-' + selected}>{selected}</span><strong>{agent.name}의 결과</strong><span className="subtle">{clock(currentOutput.createdAt)}</span><button className="text-button" onClick={() => navigator.clipboard.writeText(currentOutput.text).catch(() => setError('클립보드에 복사하지 못했습니다.'))}>결과 복사</button></div><div className="output-text">{currentOutput.text}</div>{selectedFindings.length > 0 && <button className="text-button findings-shortcut" onClick={() => setPage('findings')}>이 에이전트의 발견 사항 {selectedFindings.length}건 확인 →</button>}<details className="history"><summary>전체 대화 기록 · {agent.history.length}개</summary>{agent.history.map((message, index) => <div key={index} className={'history-message ' + message.role}><small>{message.role === 'user' ? '사용자' : agent.name} · {clock(message.createdAt)}</small><p>{message.text}</p></div>)}</details></> : <div className="empty-result"><span>✧</span><div><strong>첫 번째 실행을 기다리고 있어요</strong><p>프롬프트를 입력하고 실행하면 결과와 발견 사항이 여기에 모입니다.</p></div></div>}</div> : <div className="event-list">{agentEvents.length ? [...agentEvents].reverse().slice(0, 100).map(event => <div className="event-row" key={event.id}><time>{clock(event.createdAt)}</time><span className={'event-kind ' + event.kind}>{event.kind}</span><p>{event.message}</p>{event.message.match(/[a-f0-9-]{36}-[A-E]-[a-f0-9-]{36}\.zip/) && <a href={'/api/artifacts/' + event.message.match(/[a-f0-9-]{36}-[A-E]-[a-f0-9-]{36}\.zip/)![0]}>추적 다운로드</a>}</div>) : <div className="empty-result">아직 활동 기록이 없습니다.</div>}</div>}
          </section>
        </>}
        {page === 'findings' && <><div className="findings-toolbar"><div className="filter-tabs">{[['all', '전체'], ['bug', '버그'], ['security', '보안'], ['ux', 'UX 개선'], ['idea', '아이디어']].map(([value, label]) => <button key={value} className={filter === value ? 'active' : ''} onClick={() => setFilter(value)}>{label}</button>)}</div><div className="export-buttons"><a className="button secondary small" href="/api/report?format=md">↓ Markdown</a><a className="button secondary small" href="/api/report?format=json">↓ JSON</a></div></div><div className="verification-note">AI의 관찰은 검증된 결함과 다릅니다. 증거와 절차를 확인한 뒤 직접 재현한 기록만 ‘사용자 재현 확인’으로 변경하세요.</div>{visibleFindings.length ? <div className="findings-list">{visibleFindings.map(finding => <FindingCard key={finding.id} finding={finding} disabled={busy || !connected} verify={verification => void perform(() => api('/findings/' + finding.id, 'PATCH', { verification }))}/>)}</div> : <section className="panel empty-findings"><span>◈</span><h2>아직 발견 사항이 없어요</h2><p>에이전트가 문제나 아이디어를 기록하면 실행 중에도 이곳에서 확인할 수 있습니다.</p><button className="button secondary" onClick={() => setPage('workspace')}>워크스페이스로 돌아가기 →</button></section>}</>}
        {page === 'settings' && <div className="settings-grid"><section className="panel"><div className="panel-heading"><h2>테스트 대상 및 공통 지침</h2></div><div className="settings-form"><label>서비스 URL<input value={settings.targetUrl} onChange={event => setSettings(previous => ({ ...previous, targetUrl: event.target.value }))} disabled={active || busy}/></label><p className="field-note">대상 주소 변경 전 새 테스트를 시작하세요. AI 도구는 대상과 같은 origin에서만 동작합니다.</p><label>공통 지침<textarea value={settings.instructions} onChange={event => setSettings(previous => ({ ...previous, instructions: event.target.value }))} disabled={active || busy} maxLength={12000}/></label><button className="button primary" disabled={active || busy || !connected} onClick={() => void perform(() => api('/settings', 'PATCH', settings))}>설정 저장</button></div></section><div><section className="panel runtime-settings"><div className="panel-heading"><h2>실행 환경</h2><span className="tag">로컬 설정</span></div><dl><div><dt>AI 모델</dt><dd>{state.model || '미설정'}</dd></div><div><dt>최대 모델 턴</dt><dd>{state.maxTurns}턴 / 실행</dd></div><div><dt>실행 시간 제한</dt><dd>{state.timeoutSeconds}초 / 실행</dd></div><div><dt>동시 실행</dt><dd>1명 · 자동 대기열 없음</dd></div><div><dt>컨텍스트</dt><dd>에이전트별 독립</dd></div></dl><p>프로젝트의 <code>.env.example</code>을 <code>.env</code>로 복사하고 API 키와 모델을 설정하세요. 변경 후 서버를 재시작하세요.</p><p>화면의 텍스트와 프롬프트는 AI API로 전송됩니다. 비밀번호와 인증 토큰은 프롬프트에 입력하지 마세요.</p></section><section className="session-note"><strong>새 테스트의 초기화 범위</strong><p>5명의 대화·실행 상태·현재 결과를 초기화하고 브라우저를 닫습니다. 계정별 로그인 프로필과 이전 테스트 기록은 로컬에 유지됩니다.</p></section></div></div>}
        <footer className="page-footer"><span><i/>당신의 시나리오로, 더 나은 서비스를.</span><span>AGENT QA <span className="footer-separator">/</span> LOCAL WORKSPACE</span></footer>
      </main>
    </div>
    {resetDialog && <div className="modal-backdrop" onClick={() => { if (!busy) setResetDialog(false); }}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="reset-title" onClick={event => event.stopPropagation()}><span className="modal-icon">↻</span><h2 id="reset-title">새 테스트를 시작할까요?</h2><p>5명의 대화와 현재 결과가 초기화되고 브라우저가 닫힙니다. 로그인 프로필은 유지됩니다. 이전 기록은 로컬 DB에 보관되며 현재 결과는 미리 내보낼 수 있습니다.</p><div className="export-buttons"><a className="text-button" href="/api/report?format=md">현재 리포트 내보내기 ↓</a></div><div className="modal-actions"><button className="button secondary" disabled={busy} onClick={() => setResetDialog(false)}>취소</button><button className="button primary" disabled={busy} onClick={() => void perform(async () => { await saveAgent(); return api('/tests/new', 'POST', {}); }).then(next => { if (next) setResetDialog(false); })}>{busy ? '초기화 중…' : '새 테스트 시작'}</button></div></section></div>}
  </div>;
}
function FindingCard({ finding, disabled, verify }: { finding: Finding; disabled: boolean; verify: (value: Finding['verification']) => void }) {
  return <article className="panel finding-card"><div className="finding-top"><span className={'category-tag ' + finding.category}>{categoryLabel[finding.category]}</span><span className={'severity ' + finding.severity}>{finding.severity === 'high' ? '높음' : finding.severity === 'medium' ? '보통' : '낮음'}</span><span className="subtle">Agent {finding.agentId} · {clock(finding.createdAt)}</span><label className="verification-select"><span className="sr-only">검증 상태</span><select value={finding.verification} disabled={disabled} onChange={event => verify(event.target.value as Finding['verification'])}>{Object.entries(verificationLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div><h3>{finding.title}</h3><p className="output-text">{finding.detail}</p><details><summary>재현 절차 및 근거</summary><p className="output-text">{finding.steps}</p>{finding.evidence ? <a href={'/api/artifacts/' + finding.evidence} target="_blank" rel="noreferrer"><img src={'/api/artifacts/' + finding.evidence} alt="발견 시점의 화면 증거"/></a> : <p>확보된 화면 증거가 없습니다.</p>}</details></article>;
}
