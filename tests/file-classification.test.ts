import { expect, test } from 'vitest'
import { classifyExtension, normalizedExtension } from '../src/main/insights/fileClassification'

test.each([
  ['photo.JPG', 'jpg', 'images'],
  ['clip.MkV', 'mkv', 'videos'],
  ['song.OpUs', 'opus', 'audio'],
  ['table.tsv', 'tsv', 'documents'],
  ['doc.PdF', 'pdf', 'documents'],
  ['backup.tar.GZ', 'gz', 'archives'],
  ['source.d.TS', 'ts', 'code'],
  ['installer.MsIx', 'msix', 'applications'],
  ['unrecognized.weird', 'weird', 'other'],
  ['README', null, 'other'],
  ['.gitignore', null, 'other'],
  ['..hidden', null, 'other'],
  ['.config.JSON', 'json', 'code'],
  ['notes.txt.', null, 'other'],
  ['name..DOCX', 'docx', 'documents'],
  ['.', null, 'other'],
  ['..', null, 'other'],
  ['文件.ÉX', 'éx', 'other'],
  ['文件.E\u0301X', 'e\u0301x', 'other'],
  ['emoji.📁', '📁', 'other'],
  ['unpaired.\ud800', '\ud800', 'other'],
  ['', null, 'other']
] as const)('classifies %s by its normalized suffix only', (name, suffix, category) => {
  expect(normalizedExtension(name)).toBe(suffix)
  expect(classifyExtension(suffix)).toBe(category)
})
