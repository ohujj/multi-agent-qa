import type { ActivityKind, AgentId, AgentStatus, FeedbackContext, Finding, Message, Settings } from '../shared/types.js';
export type ParentCommand =
  | { type: 'open'; testId: string; agentId: AgentId; settings: Settings }
  | { type: 'run'; testId: string; agentId: AgentId; settings: Settings; role: string; prompt: string; history: Message[]; runId: string }
  | { type: 'finish'; context: FeedbackContext }
  | { type: 'pause' | 'resume' | 'stop' | 'close' };
export type WorkerEvent =
  | { type: 'ready'; browserOpen: boolean }
  | { type: 'status'; status: AgentStatus; action: string }
  | { type: 'action'; message: string }
  | { type: 'progress'; kind: ActivityKind; message: string; source: 'system' | 'agent'; createdAt: string }
  | { type: 'screenshot'; file: string }
  | { type: 'finding'; finding: Finding }
  | { type: 'done'; status: 'waiting' | 'completed' | 'failed'; output: string; source: 'system' | 'agent' };
