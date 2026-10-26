import type { Dashboard } from '../shared/types.js';
export function markdownReport(state: Dashboard) {
  const categories = { bug: '버그', security: '보안 의심', ux: 'UX', idea: '아이디어' };
  const verification = { suspected: '미확인', observed: '관찰됨 · 독립 검증 필요', reproduced: '사용자 재현 확인' };
  const grouped = new Map<string, typeof state.findings>();
  for (const finding of state.findings) {
    const key = finding.category + ':' + finding.title.toLowerCase().replace(/\s/g, '');
    grouped.set(key, [...(grouped.get(key) || []), finding]);
  }
  return [
    '# Agent QA 테스트 리포트', '',
    '- 테스트 ID: ' + state.testId, '- 시작: ' + state.startedAt,
    '- 대상: ' + state.settings.targetUrl, '- 모델: ' + (state.model || '미설정'),
    '- 발견 기록: ' + state.findings.length + '건 / 제목 기준 묶음: ' + grouped.size + '건',
    '', '> AI 판단과 실제 검증은 다릅니다. 같은 제목으로 묶은 결과도 동일 원인으로 확정하지 않습니다.', '',
    '## 에이전트별 실행 결과', '',
    ...state.agents.flatMap(agent => [
      '### ' + agent.name + ' · ' + agent.status, '',
      '역할: ' + (agent.role || '미지정'), '계정 별칭: ' + (agent.accountLabel || '미지정'), '',
      ...agent.history.flatMap(message => ['**' + (message.role === 'user' ? '사용자' : '에이전트') + '** · ' + message.createdAt, '', message.text, '']),
    ]),
    '## 통합 발견 사항', '',
    ...[...grouped.values()].flatMap(group => [
      '### ' + group[0].title, '',
      '분류: ' + categories[group[0].category] + ' · 발견 에이전트: ' + [...new Set(group.map(finding => finding.agentId))].join(', '), '',
      ...group.flatMap(finding => [
        '- 기록 ID: ' + finding.id, '- 심각도: ' + finding.severity,
        '- 검증: ' + verification[finding.verification], '',
        finding.detail, '', '**재현 절차**', '', finding.steps, '',
        '로컬 증거 파일: ' + (finding.evidence || '없음'), '',
      ]),
    ]),
    '## 이벤트', '',
    ...state.events.map(event => '- ' + event.createdAt + ' [' + (event.agentId || '전체') + '] [' + event.kind + ' / ' + (event.source === 'agent' ? 'AI 요약' : '시스템') + '] ' + event.message),
    '',
  ].join('\n');
}
