export const AGENT_IDS = ['A', 'B', 'C', 'D', 'E'] as const;
export type AgentId = typeof AGENT_IDS[number];
export type AgentStatus = 'idle' | 'running' | 'pausing' | 'paused' | 'waiting' | 'summarizing' | 'stopping' | 'completed' | 'failed' | 'cancelled';
export type CaptureMode = 'off' | 'findings' | 'actions';
export type ActivityKind = 'goal' | 'observation' | 'decision' | 'action' | 'result' | 'suspicion' | 'verification' | 'feedback';
export type Finding = {
  id: string; agentId: AgentId; runId: string; createdAt: string;
  category: 'bug' | 'security' | 'ux' | 'idea'; title: string; detail: string;
  steps: string; severity: 'low' | 'medium' | 'high';
  verification: 'suspected' | 'observed' | 'reproduced'; evidence: string | null;
};
export type Message = { role: 'user' | 'assistant'; text: string; createdAt: string };
export type AgentView = {
  id: AgentId; name: string; role: string; prompt: string; accountLabel: string;
  status: AgentStatus; action: string; browserOpen: boolean;
  history: Message[]; screenshot: string | null;
};
export type EventRecord = { id: number; createdAt: string; agentId: AgentId | null; kind: string; message: string; source?: 'system' | 'agent' };
export type Settings = { targetUrl: string; instructions: string; captureMode: CaptureMode };
export type FeedbackContext = { agentId: AgentId; targetUrl: string; role: string; history: Message[]; events: EventRecord[]; findings: Finding[] };
export type Dashboard = {
  testId: string; startedAt: string; agents: AgentView[]; events: EventRecord[];
  findings: Finding[]; settings: Settings; activeAgent: AgentId | null;
  configured: boolean; model: string; maxTurns: number; timeoutSeconds: number;
};
