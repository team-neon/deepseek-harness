/**
 * 锁定 Web 启动脚本的重建判定和快照标记。
 * 只调用纯函数与临时目录里的标记读写，不执行 `clean`、`install` 或 `build`。
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  WEB_UP_ARTIFACT_PATH,
  WEB_UP_DSH_HOME,
  WEB_UP_STAMP_PATH,
  needsWebRebuild,
  readSourceSnapshot,
  readWebUpStamp,
  sourceSnapshotText,
  writeWebUpStamp,
} from './web-up.ts'

const snapshot = 'abc123\n M packages/example/src/index.ts\n'

describe('web-up rebuild decision', () => {
  it('owns the launch home and the stamp and artifact paths', () => {
    expect(WEB_UP_DSH_HOME).toBe('/Users/wuze/Documents/deepseek-harness')
    expect(WEB_UP_STAMP_PATH).toBe('.local/dsh-web-stamp')
    expect(WEB_UP_ARTIFACT_PATH).toBe('apps/web/dist/index.html')
  })

  it('rebuilds when the stamp is missing, differs, or the web artifact is absent', () => {
    expect(needsWebRebuild({ stamp: undefined, snapshot, artifactExists: true })).toBe(true)
    expect(needsWebRebuild({ stamp: 'other\n', snapshot, artifactExists: true })).toBe(true)
    expect(needsWebRebuild({ stamp: snapshot, snapshot, artifactExists: false })).toBe(true)
  })

  it('skips the rebuild when the stamp matches and the artifact exists', () => {
    expect(needsWebRebuild({ stamp: snapshot, snapshot, artifactExists: true })).toBe(false)
  })

  it('keeps the git status text after the commit id', () => {
    expect(sourceSnapshotText('abc123\n', ' M file\n')).toBe('abc123\n M file\n')
    expect(sourceSnapshotText('abc123', '')).toBe('abc123\n')
  })

  it('round-trips a stamp and treats a missing file as unset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-web-up-'))
    const path = join(root, '.local', 'dsh-web-stamp')
    try {
      expect(await readWebUpStamp(path)).toBeUndefined()
      await writeWebUpStamp(path, snapshot)
      expect(await readWebUpStamp(path)).toBe(snapshot)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reads the repository snapshot from git', async () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const text = await readSourceSnapshot(root)
    expect(text).toMatch(/^[0-9a-f]{40}\n/)
  })
})
