import { StateStore } from '../../state-store.js'
import { Importer } from '../../importer.js'
import { selectThreadSource } from '../../storage-policy.js'
import type { ProjectRecord, ThreadRecord } from '../../models.js'

/**
 * Checks whether a value looks like a UUID-style thread id.
 */
function isThreadId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value,
  )
}

function buildNewThreadTitle(project: ProjectRecord): string {
  return `New thread ${project.name}`
}

export class ThreadService {
  constructor(
    private stateStore: StateStore,
    private importer: Importer,
  ) {}

  async createThread(
    projectId: string,
    sourceId: string,
    cwd: string,
    title?: string,
    originator?: string,
  ): Promise<ThreadRecord> {
    const project = this.stateStore.getProject(projectId)
    if (!project) {
      throw new Error('Project not found')
    }

    const sourceSelection = selectThreadSource({
      sources: this.stateStore.listSources({ includeDisabled: true }),
      projectDefaultSourceId: sourceId,
      projectSourceMode: project.sourceMode,
    })

    if (!sourceSelection.source) {
      throw new Error('No available source for new thread')
    }

    return this.stateStore.createThread(projectId, {
      sourceId: sourceSelection.source.id,
      cwd,
      title: title ?? buildNewThreadTitle(project),
      origin: 'telegram',
      originator: originator ?? 'telegram',
      status: 'idle',
    })
  }

  async renameThread(threadId: string, newTitle: string): Promise<ThreadRecord> {
    const normalizedName = newTitle.trim()
    if (!normalizedName) {
      throw new Error('Thread name is required')
    }

    return this.stateStore.updateThread(threadId, { title: normalizedName })
  }

  async archiveThread(threadId: string): Promise<ThreadRecord> {
    return this.stateStore.archiveThread(threadId)
  }

  async deleteThread(threadId: string): Promise<void> {
    await this.stateStore.deleteThread(threadId)
  }

  async moveThread(threadId: string, targetProjectId: string): Promise<ThreadRecord> {
    return this.stateStore.updateThread(threadId, { projectId: targetProjectId })
  }

  async pinThread(threadId: string): Promise<ThreadRecord> {
    return this.stateStore.pinThread(threadId)
  }

  async unpinThread(threadId: string): Promise<ThreadRecord> {
    return this.stateStore.unpinThread(threadId)
  }

  async getOrCreateActiveThread(
    projectId: string,
    sourceId: string,
    cwd: string,
    currentThreadId?: string,
  ): Promise<ThreadRecord> {
    if (currentThreadId) {
      const existing = this.stateStore.getThread(currentThreadId)
      if (existing) {
        return existing
      }
    }

    return this.createThread(projectId, sourceId, cwd)
  }

  /**
   * Resolve a thread reference (numeric index, thread id, or codex thread id)
   * within the given project context.  When the reference looks like a UUID
   * that is not yet known locally, the method triggers an import sync and – if
   * the thread still cannot be found – creates a stub record.
   *
   * Returns the resolved thread and whether it was newly added.
   */
  async resolveThread(
    reference: string,
    project: ProjectRecord,
  ): Promise<{ thread: ThreadRecord; added: boolean } | undefined> {
    const normalizedReference = reference.trim()
    if (!normalizedReference) {
      return undefined
    }

    let thread: ThreadRecord | undefined
    let added = false

    if (/^\d+$/.test(normalizedReference)) {
      const threads = this.stateStore.listThreads(project.id)
      const index = Number.parseInt(normalizedReference, 10) - 1
      thread = threads[index]
    } else {
      thread =
        this.stateStore.findThread(normalizedReference, project.id) ??
        this.stateStore.findThread(normalizedReference)
    }

    if (!thread && isThreadId(normalizedReference)) {
      const imported = await this.importer.syncEnabledSources()
      void imported
      thread =
        this.stateStore.findThread(normalizedReference, project.id) ??
        this.stateStore.findThread(normalizedReference)
    }

    if (!thread && isThreadId(normalizedReference)) {
      thread = await this.stateStore.createThread(project.id, {
        sourceId: project.defaultSourceId,
        cwd: project.cwd,
        title: `${project.name} ${normalizedReference.slice(0, 8)}`,
        origin: 'imported',
        originator: 'imported',
        codexThreadId: normalizedReference,
        status: 'idle',
      })
      added = true
    }

    if (!thread) {
      return undefined
    }

    return { thread, added }
  }
}
