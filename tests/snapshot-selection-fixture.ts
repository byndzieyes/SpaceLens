import { vi } from 'vitest'
import type { SpaceLensAPI } from '../src/shared/ipc'

/** Forward the selection path to each existing page fixture's Latest read. */
export function mockSnapshotSelection(readLatest: SpaceLensAPI['getScanSnapshot']): {
  [
    K in 'prepareSnapshotSelection' | 'adoptSnapshotSelection' | 'releaseSnapshotSelection'
  ]: ReturnType<typeof vi.fn<SpaceLensAPI[K]>>
} {
  let sequence = 0
  return {
    prepareSnapshotSelection: vi.fn(async ({ selection }) => {
      if (selection.mode !== 'follow-latest')
        throw new Error('Expected Follow Latest in this fixture.')
      const result = await readLatest()
      if (!result.ok) return result
      return {
        ok: true,
        value: {
          ticket: String(++sequence),
          resolution: { mode: 'follow-latest', availability: result.value }
        }
      }
    }),
    adoptSnapshotSelection: vi.fn(async () => ({ ok: true, value: null })),
    releaseSnapshotSelection: vi.fn(async () => ({ ok: true, value: null }))
  }
}
