import { getDatabase } from './state-store.js'
import { CursorRepository } from './src/data/repositories/cursor-repo.js'

export interface SourceCursor {
  lastScanAt?: string
  lastScanStartedAt?: string
  lastScanCompletedAt?: string
  lastImportedMtimeMs?: number
  lastImportedPath?: string
  lastSeenMtimeMs?: number
  lastSeenPath?: string
  lastSessionIndexMtimeMs?: number
  lastSessionIndexFingerprint?: string
  files: Record<string, number>
  fileFingerprints?: Record<string, string>
}

export interface SourceCursorPatch {
  lastScanAt?: string
  lastScanStartedAt?: string
  lastScanCompletedAt?: string
  lastImportedMtimeMs?: number
  lastImportedPath?: string
  lastSeenMtimeMs?: number
  lastSeenPath?: string
  lastSessionIndexMtimeMs?: number
  lastSessionIndexFingerprint?: string
  files?: Record<string, number>
  fileFingerprints?: Record<string, string>
}

export class ImportCursorStore {
  private repo!: CursorRepository
  private initialized = false

  async init(): Promise<void> {
    if (this.initialized) {
      return
    }

    this.repo = new CursorRepository(getDatabase())
    this.initialized = true
  }

  getSourceCursor(sourceId: string): SourceCursor {
    if (!this.initialized) {
      this.repo = new CursorRepository(getDatabase())
      this.initialized = true
    }
    return this.repo.getCursor(sourceId)
  }

  async setSourceCursor(sourceId: string, cursor: SourceCursor): Promise<void> {
    await this.init()
    this.repo.setCursor(sourceId, cursor)
  }

  async patchSourceCursor(sourceId: string, patch: SourceCursorPatch): Promise<SourceCursor> {
    await this.init()
    return this.repo.patchCursor(sourceId, patch)
  }
}
