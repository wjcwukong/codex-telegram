import { resolveProjectIdentity } from '../../project-normalizer.js'
import type { StateStore } from '../../state-store.js'
import type {
  AgentParentSourceOverrideMode,
  ProjectRecord,
  ProjectSourceMode,
  SourceRecord,
} from '../../models.js'

/**
 * Pure project-management operations – no knowledge of sessions or users.
 * Receives resolved IDs from the caller (SessionManager).
 */
export class ProjectService {
  constructor(private readonly stateStore: StateStore) {}

  // ── create ────────────────────────────────────────────────────────────

  async createProject(
    name: string,
    cwd: string,
    fallbackDefaultSourceId: string,
  ): Promise<ProjectRecord> {
    const normalizedName = name.trim()
    if (!normalizedName) {
      throw new Error('Project name is required')
    }

    const identity = await resolveProjectIdentity(cwd)
    const existing = this.stateStore.findProjectByProjectKey(identity.projectKey)
    if (existing) {
      throw new Error(`Project already exists for cwd: ${existing.cwd}`)
    }

    return this.stateStore.createProject(
      normalizedName,
      identity.cwd,
      fallbackDefaultSourceId,
      identity.projectKey,
    )
  }

  // ── rename ────────────────────────────────────────────────────────────

  async renameProject(
    projectId: string,
    newName: string,
  ): Promise<ProjectRecord> {
    const normalizedName = newName.trim()
    if (!normalizedName) {
      throw new Error('Project name is required')
    }

    return this.stateStore.updateProject(projectId, { name: normalizedName })
  }

  // ── archive / delete ──────────────────────────────────────────────────

  async archiveProject(projectId: string): Promise<ProjectRecord> {
    return this.stateStore.archiveProject(projectId)
  }

  async deleteProject(projectId: string): Promise<void> {
    await this.stateStore.deleteProject(projectId)
  }

  // ── source / mode settings ────────────────────────────────────────────

  async setProjectSource(
    projectId: string,
    sourceId: string,
  ): Promise<{ project: ProjectRecord; source: SourceRecord }> {
    const normalizedSourceId = sourceId.trim()
    const source = this.stateStore.getSource(normalizedSourceId)
    if (!source) {
      throw new Error(`Unknown source: ${sourceId}`)
    }

    const project = await this.stateStore.updateProject(projectId, {
      defaultSourceId: source.id,
    })

    return { project, source }
  }

  async setProjectSourceMode(
    projectId: string,
    sourceMode: ProjectSourceMode,
  ): Promise<ProjectRecord> {
    return this.stateStore.updateProject(projectId, { sourceMode })
  }

  async setProjectAgentSourceOverrideMode(
    projectId: string,
    agentSourceOverrideMode: AgentParentSourceOverrideMode,
  ): Promise<ProjectRecord> {
    return this.stateStore.updateProject(projectId, { agentSourceOverrideMode })
  }

  async setProjectAgentAutoWriteback(
    projectId: string,
    agentAutoWritebackEnabled: boolean,
  ): Promise<ProjectRecord> {
    return this.stateStore.updateProject(projectId, { agentAutoWritebackEnabled })
  }

  // ── lookup helpers ────────────────────────────────────────────────────

  resolveProjectReference(reference: string): ProjectRecord | undefined {
    const normalizedReference = reference.trim()
    if (!normalizedReference) {
      return undefined
    }

    if (/^\d+$/.test(normalizedReference)) {
      const projects = this.stateStore.listProjects()
      const index = Number.parseInt(normalizedReference, 10) - 1
      return projects[index]
    }

    return this.stateStore.findProject(normalizedReference)
  }
}
