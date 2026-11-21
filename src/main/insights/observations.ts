import type {
  InsightsCategories,
  InsightsObservations,
  InsightsRankedEntry,
  InsightsSizeDistribution,
  InsightsSummary
} from '../../shared/insights'

// All thresholds are inclusive. Positive-file minima keep empty files from inflating byte samples.
const LARGEST_FILES = 5
const MIN_POSITIVE_FILES = 10
const LARGE_FILE_PERCENT = 50
const DOMINANT_CATEGORY_PERCENT = 60
const MIN_NON_ROOT_DIRECTORIES = 2 // Counts only directories with positive known bytes.
const DIRECTORY_PERCENT = 50
const MIN_KNOWN_FILES = 20
const SMALL_FILES_PERCENT = 80

function reachesShare(part: bigint, total: number, percent: number): boolean {
  return total > 0 && part <= BigInt(total) && part * 100n >= BigInt(total) * BigInt(percent)
}

export function buildObservations(
  { scanId, summary }: Pick<InsightsSummary, 'scanId' | 'summary'>,
  distribution: InsightsSizeDistribution,
  readConcentrationSources: () => {
    categories: InsightsCategories
    files: readonly InsightsRankedEntry[]
    directories: readonly InsightsRankedEntry[]
  }
): InsightsObservations {
  const observations: InsightsObservations['observations'][number][] = []
  const { errorCount, totalBytes: totalKnownBytes } = summary
  const {
    knownSizeCount,
    totals: { unknownSizeCount }
  } = distribution
  const [emptyBucket, tinyBucket] = distribution.buckets
  const empty = emptyBucket.fileCount
  const tiny = tinyBucket.fileCount
  const incomplete = errorCount > 0 || unknownSizeCount > 0

  if (incomplete) {
    observations.push({
      id: 'incompleteScan',
      type: 'incompleteScan',
      severity: 'warning',
      title: 'Incomplete scan coverage',
      message:
        'Filesystem errors or unknown file sizes limit coverage. These results describe the data the scan could observe.',
      evidence: { errorCount, unknownSizeCount }
    })
  }

  if (knownSizeCount - empty >= MIN_POSITIVE_FILES && totalKnownBytes > 0) {
    const { categories, files, directories } = readConcentrationSources()
    const largest = files.slice(0, LARGEST_FILES)
    const largestBytes = largest.reduce((sum, entry) => sum + BigInt(entry.bytes ?? 0), 0n)
    if (
      largest.length === LARGEST_FILES &&
      largest.every(({ bytes }) => (bytes ?? 0) > 0) &&
      reachesShare(largestBytes, totalKnownBytes, LARGE_FILE_PERCENT)
    ) {
      observations.push({
        id: 'largeFileConcentration',
        type: 'largeFileConcentration',
        severity: 'info',
        title: 'Known bytes concentrated in a few files',
        message: `The ${LARGEST_FILES} largest files account for at least ${LARGE_FILE_PERCENT}% of known logical bytes.`,
        evidence: { fileCount: LARGEST_FILES, knownBytes: Number(largestBytes), totalKnownBytes }
      })
    }

    const dominant = categories.categories.reduce<
      (typeof categories.categories)[number] | undefined
    >(
      (largest, row) => (!largest || row.knownBytes > largest.knownBytes ? row : largest),
      undefined
    )
    if (
      dominant &&
      reachesShare(BigInt(dominant.knownBytes), totalKnownBytes, DOMINANT_CATEGORY_PERCENT)
    ) {
      observations.push({
        id: 'dominantCategory',
        type: 'dominantCategory',
        severity: 'info',
        title: 'One file category has a large byte share',
        message: `The ${dominant.category} category accounts for at least ${DOMINANT_CATEGORY_PERCENT}% of known logical bytes.`,
        evidence: { category: dominant.category, knownBytes: dominant.knownBytes, totalKnownBytes }
      })
    }

    const [largestDirectory, secondDirectory] = directories.slice(0, MIN_NON_ROOT_DIRECTORIES)
    if (
      largestDirectory?.bytes &&
      (secondDirectory?.bytes ?? 0) > 0 &&
      reachesShare(BigInt(largestDirectory.bytes), totalKnownBytes, DIRECTORY_PERCENT)
    ) {
      observations.push({
        id: 'directoryConcentration',
        type: 'directoryConcentration',
        severity: 'info',
        title: 'Known bytes concentrated in one directory',
        message: `The largest non-root directory contains at least ${DIRECTORY_PERCENT}% of known logical bytes.`,
        evidence: {
          entryId: largestDirectory.id,
          knownBytes: largestDirectory.bytes,
          totalKnownBytes
        }
      })
    }
  }

  const smallFileCount = empty + tiny
  if (
    knownSizeCount >= MIN_KNOWN_FILES &&
    reachesShare(BigInt(smallFileCount), knownSizeCount, SMALL_FILES_PERCENT)
  ) {
    observations.push({
      id: 'smallFilesPrevalence',
      type: 'smallFilesPrevalence',
      severity: 'info',
      title: 'Most measured files are small',
      message: `At least ${SMALL_FILES_PERCENT}% of files with known sizes are empty or smaller than 1 MiB.`,
      evidence: { smallFileCount, knownSizeCount }
    })
  }

  return { scanId, incomplete, observations }
}
