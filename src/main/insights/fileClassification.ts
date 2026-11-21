import type { InsightsFileCategory } from '../../shared/insights'

// Filename heuristics. Application installers and binaries are distinct from source code.
const extensionsByCategory = {
  images: [
    'avif',
    'bmp',
    'gif',
    'heic',
    'heif',
    'ico',
    'jpeg',
    'jpg',
    'png',
    'raw',
    'svg',
    'tif',
    'tiff',
    'webp'
  ],
  videos: ['3gp', 'avi', 'flv', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg', 'webm', 'wmv'],
  audio: ['aac', 'aiff', 'flac', 'm4a', 'mp3', 'ogg', 'opus', 'wav', 'wma'],
  documents: [
    'csv',
    'doc',
    'docx',
    'epub',
    'md',
    'odf',
    'odp',
    'ods',
    'odt',
    'pdf',
    'ppt',
    'pptx',
    'rtf',
    'tsv',
    'txt',
    'xls',
    'xlsx'
  ],
  archives: ['7z', 'bz2', 'gz', 'rar', 'tar', 'tgz', 'xz', 'zip', 'zst'],
  code: [
    'bash',
    'bat',
    'c',
    'cpp',
    'cs',
    'css',
    'go',
    'h',
    'hpp',
    'html',
    'java',
    'js',
    'json',
    'jsx',
    'kt',
    'mjs',
    'php',
    'ps1',
    'py',
    'rb',
    'rs',
    'sh',
    'sql',
    'swift',
    'toml',
    'ts',
    'tsx',
    'xml',
    'yaml',
    'yml'
  ],
  applications: [
    'apk',
    'bin',
    'deb',
    'dll',
    'dmg',
    'exe',
    'ipa',
    'iso',
    'msi',
    'msix',
    'pkg',
    'rpm',
    'so'
  ]
} satisfies Record<Exclude<InsightsFileCategory, 'other'>, readonly string[]>

const categories = new Map<string, InsightsFileCategory>()
for (const [category, extensions] of Object.entries(extensionsByCategory)) {
  for (const extension of extensions) categories.set(extension, category as InsightsFileCategory)
}

/** Use the final suffix (archive.tar.gz → gz). Leading dots alone and trailing dots have no suffix. */
export function normalizedExtension(name: string): string | null {
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1 || /^\.+$/.test(name.slice(0, dot))) return null
  // Locale-independent case conversion, preserving other UTF-16 code units.
  return name.slice(dot + 1).toLowerCase()
}

export function classifyExtension(extension: string | null): InsightsFileCategory {
  return extension === null ? 'other' : (categories.get(extension) ?? 'other')
}
