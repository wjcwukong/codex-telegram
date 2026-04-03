import { readFile, rename, writeFile } from 'node:fs/promises'

import {
  getHistoryEntryKey,
  HistoryReader,
  type HistoryTurn,
} from '../../history-reader.js'
import { isIsolatedStoragePolicy } from '../../storage-policy.js'
import type { AgentSnapshot } from '../../agent-manager.js'
import type { ThreadRecord } from '../../models.js'
import { StateStore } from '../../state-store.js'

export class UndoManager {
  constructor(
    private readonly stateStore: StateStore,
    private readonly historyReader: HistoryReader,
  ) {}

  /**
   * Physically remove the last turn's entries from the rollout files on disk.
   * Only allowed when the thread originates from telegram and its source uses
   * isolated storage.  Falls back by throwing so the caller can use the
   * "hidden keys" strategy instead.
   */
  async rewriteLastTurnInSource(
    thread: ThreadRecord,
    targetTurn: HistoryTurn,
  ): Promise<number> {
    const source = this.stateStore.getSource(thread.sourceId)
    if (
      !source ||
      !isIsolatedStoragePolicy(source.storagePolicy) ||
      thread.origin !== 'telegram'
    ) {
      throw new Error('Thread source is not safe for physical undo')
    }

    if (!targetTurn?.userEntry) {
      throw new Error('No source-backed user turn available to rewrite')
    }

    const rawRecords = await this.historyReader.readThreadRawRecords(thread)
    const targetUserEntryKey = getHistoryEntryKey(targetTurn.userEntry)
    const targetUserIndex = rawRecords.findIndex(
      (record) =>
        record.entry?.role === 'user' &&
        getHistoryEntryKey(record.entry) === targetUserEntryKey,
    )
    const lastRawUserIndex = [...rawRecords]
      .map((record, index) => ({ record, index }))
      .reverse()
      .find(({ record }) => record.entry?.role === 'user')?.index

    if (targetUserIndex === -1 || lastRawUserIndex === undefined) {
      throw new Error('No source-backed user turn available to rewrite')
    }

    if (targetUserIndex !== lastRawUserIndex) {
      throw new Error(
        'Latest visible user turn is not the latest source-backed turn',
      )
    }

    const tail = rawRecords.slice(targetUserIndex)
    const linesByFile = new Map<string, Set<number>>()
    for (const record of tail) {
      const lines = linesByFile.get(record.rolloutPath) ?? new Set<number>()
      lines.add(record.lineNumber)
      linesByFile.set(record.rolloutPath, lines)
    }

    const plans: Array<{
      rolloutPath: string
      originalContent: string
      nextContent: string
      tmpPath: string
    }> = []
    for (const [rolloutPath, lineNumbers] of linesByFile) {
      const originalContent = await readFile(rolloutPath, 'utf8')
      const nextContent = originalContent
        .split('\n')
        .filter((_, index) => !lineNumbers.has(index + 1))
        .join('\n')
        .replace(/\n*$/, '\n')
      plans.push({
        rolloutPath,
        originalContent,
        nextContent,
        tmpPath: `${rolloutPath}.${process.pid}.${Date.now()}.tmp`,
      })
    }

    for (const plan of plans) {
      await writeFile(
        plan.tmpPath,
        plan.nextContent.trim() ? plan.nextContent : '',
        'utf8',
      )
    }

    let rewrittenFiles = 0
    const applied: typeof plans = []
    try {
      for (const plan of plans) {
        await rename(plan.tmpPath, plan.rolloutPath)
        applied.push(plan)
        rewrittenFiles += 1
      }
    } catch (error) {
      for (const plan of applied.reverse()) {
        const rollbackPath = `${plan.rolloutPath}.${process.pid}.${Date.now()}.rollback`
        await writeFile(rollbackPath, plan.originalContent, 'utf8')
        await rename(rollbackPath, plan.rolloutPath)
      }
      throw error
    }

    return rewrittenFiles
  }

  /**
   * Build the prompt that merges an agent's child-thread result back into the
   * parent thread.
   */
  async buildAgentWritebackPrompt(
    snapshot: AgentSnapshot,
  ): Promise<string | undefined> {
    const childThread = this.stateStore.getThread(
      snapshot.relation.childThreadId,
    )
    if (!childThread) {
      return undefined
    }

    const childTurn = await this.historyReader.readLastThreadHistoryTurn(
      childThread,
      {
        includeTools: true,
        includeAgentMessages: true,
      },
    )
    const childResult = childTurn?.entries
      .filter((entry) => entry.role === 'assistant')
      .map((entry) => entry.text.trim())
      .filter(Boolean)
      .join('\n\n')
      .trim()

    if (!childResult) {
      return undefined
    }

    const parentLabel =
      snapshot.relation.parentThread?.title ??
      snapshot.relation.parentThreadId
    const childLabel =
      snapshot.relation.childThread?.title ??
      snapshot.relation.childThreadId

    return [
      `Continue the parent thread using the completed ${snapshot.agent.role} agent result.`,
      `Parent thread: ${parentLabel}`,
      `Child thread: ${childLabel} (${snapshot.relation.childThreadId})`,
      `Original subtask: ${snapshot.agent.task}`,
      '',
      'Use the child result below as input to the parent thread. Merge only the useful parts and continue the main task.',
      '',
      'Child result:',
      childResult,
    ].join('\n')
  }
}
