export type SourceStoragePolicy = 'shared' | 'isolated'
export type ProjectSourceMode = 'prefer' | 'force' | 'policy-default'
export type AgentParentSourceOverrideMode = 'allow' | 'deny' | 'policy-default'
export type ThreadOrigin = 'imported' | 'telegram'
export type ThreadStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'cancelled'
  | 'failed'
export type AgentRole =
  | 'worker'
  | 'explorer'
  | 'reviewer'
  | 'summarizer'
  | 'general'
export type AgentStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface SourceRecord {
  id: string
  name: string
  codexHome: string
  enabled: boolean
  importEnabled: boolean
  storagePolicy: SourceStoragePolicy
  createdAt: string
  updatedAt: string
}

export interface ProjectRecord {
  id: string
  name: string
  cwd: string
  projectKey: string
  defaultSourceId: string
  sourceMode: ProjectSourceMode
  agentSourceOverrideMode: AgentParentSourceOverrideMode
  agentAutoWritebackEnabled: boolean
  archivedAt?: string
  createdAt: string
  updatedAt: string
}

export interface ThreadRecord {
  id: string
  projectId: string
  sourceId: string
  cwd: string
  title: string
  origin: ThreadOrigin
  originator: string
  codexThreadId?: string
  status: ThreadStatus
  pinnedAt?: string
  archivedAt?: string
  hiddenHistoryEntryKeys?: string[]
  createdAt: string
  updatedAt: string
}

export interface AgentRecord {
  id: string
  parentThreadId: string
  threadId: string
  projectId: string
  sourceId: string
  role: AgentRole
  task: string
  status: AgentStatus
  createdAt: string
  updatedAt: string
  lastError?: string
  lastMessagePreview?: string
  writebackRunId?: string
}

export interface SelectionRecord {
  currentProjectId?: string
  currentThreadId?: string
}

export interface PersistedState {
  sources: Record<string, SourceRecord>
  projects: Record<string, ProjectRecord>
  threads: Record<string, ThreadRecord>
  agents: Record<string, AgentRecord>
  selections: Record<string, SelectionRecord>
}

export interface ImportSummary {
  scannedSources: number
  scannedRollouts: number
  addedProjects: number
  updatedProjects: number
  addedThreads: number
  updatedThreads: number
}
