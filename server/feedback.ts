import type { FeedbackContext } from '../shared/types.js';
import { redact } from './config.js';

// Deterministic fallback: preserve evidence without claiming the AI completed a review.
export function recordedFeedback(context: FeedbackContext, reason: string) {
  return redact([
    '# 기록 기반 피드백', '', '정리 상태: ' + reason, '',
    '대상: ' + context.targetUrl, '에이전트: ' + context.agentId, '',
    '## 수행 요청', '',
    ...context.history.filter(item => item.role === 'user').slice(-5).map(item => '- ' + item.text),
    '', '## 기록된 행동과 관찰', '',
    ...context.events.slice(-40).map(event => '- [' + event.kind + ' / ' + (event.source === 'agent' ? 'AI 요약' : '시스템') + '] ' + event.message),
    '', '## 발견 사항', '',
    ...(context.findings.length ? context.findings.map(item =>
      '- ' + item.title + ' (' + item.verification + ')\n  ' + item.detail + '\n  재현: ' + item.steps) : ['기록된 발견 사항 없음. 문제가 없다는 보장은 아닙니다.']),
    '', '## 확인 필요', '',
    '중단 직전 쓰기 요청의 서비스 반영 여부와 미확인 의심 사항은 별도로 확인하세요.',
    '이 보고서는 저장된 기록을 정리한 결과이며, 새로운 브라우저 검증이나 독립적인 재현을 수행하지 않았습니다.',
  ].join('\n'));
}
