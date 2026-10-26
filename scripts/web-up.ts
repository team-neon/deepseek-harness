/**
 * 用一条命令启动 Web：源码变了就先 `clean`、`install`、`build`。
 * 比较 git 快照与 `.local/dsh-web-stamp`，再把 `DSH_HOME` 只传给最后的 `dsh web` 子进程。
 */

import { execa } from 'execa'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { pnpmInvocation } from './pnpm-invocation.ts'

/** 这次 `dsh web` 使用的 Harness home。常量是绝对路径，只传给最后那个子进程。 */
export const WEB_UP_DSH_HOME = '/Users/wuze/Documents/deepseek-harness'

/** 上次成功构建的源码快照。`pnpm clean` 不删除这个路径。 */
export const WEB_UP_STAMP_PATH = '.local/dsh-web-stamp'

/** Web 前端入口。缺少 `apps/web/dist/index.html` 时，即使快照一致也要重建。 */
export const WEB_UP_ARTIFACT_PATH = 'apps/web/dist/index.html'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * 决定这次启动要不要先完整重建。
 * `stamp` 缺失、与 `snapshot` 不一致、或 `artifactExists` 为 false 时返回 true。
 */
export function needsWebRebuild(input: {
  stamp: string | undefined
  snapshot: string
  artifactExists: boolean
}): boolean {
  if (!input.artifactExists) return true
  if (input.stamp === undefined) return true
  return input.stamp !== input.snapshot
}

/**
 * 把当前源码状态收成可比较的快照。
 * 拼接 `git rev-parse HEAD` 的提交号与 `git status --porcelain` 的原文。
 */
export function sourceSnapshotText(head: string, status: string): string {
  return `${head.trim()}\n${status}`
}

/**
 * 读取上次写入的源码快照。
 * 文件不存在时返回 undefined，其它读错误原样抛出。
 */
export async function readWebUpStamp(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

/**
 * 记下这次成功构建对应的源码快照。
 * 先创建 `.local`，再把 `snapshot` 原样写入标记文件。
 */
export async function writeWebUpStamp(path: string, snapshot: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, snapshot)
}

/**
 * 读取仓库当前的源码快照。
 * 依次执行 `git rev-parse HEAD` 与 `git status --porcelain --untracked-files=all`。
 */
export async function readSourceSnapshot(root: string): Promise<string> {
  const head = await gitOutput(root, ['rev-parse', 'HEAD'])
  const status = await gitOutput(root, ['status', '--porcelain', '--untracked-files=all'])
  return sourceSnapshotText(head, status)
}

/**
 * 跑一条 pnpm 命令并继承其标准流。
 * 通过 `pnpmInvocation` 调用当前 `pnpm run` 的可执行文件，返回进程退出码。
 */
async function runPnpm(args: readonly string[], environment: NodeJS.ProcessEnv): Promise<number> {
  const invocation = pnpmInvocation(args, environment)
  const result = await execa(invocation.command, invocation.args, {
    cwd: repoRoot,
    env: environment,
    stdio: 'inherit',
    reject: false,
  })
  return result.exitCode ?? 1
}

async function gitOutput(root: string, args: readonly string[]): Promise<string> {
  const result = await execa('git', [...args], { cwd: root, reject: false })
  if (result.exitCode !== 0) {
    throw new Error(`web-up: git ${args.join(' ')} exited (code ${String(result.exitCode)})\n${result.stderr}`)
  }
  return result.stdout
}

/**
 * 按快照决定是否重建，然后启动 Web。
 * 重建步骤沿用当前环境；只有随后的 `pnpm dsh web`（`apps/cli/src/bin.ts`）得到 `WEB_UP_DSH_HOME`。
 */
export async function runWebUp(args: readonly string[], environment: NodeJS.ProcessEnv = process.env): Promise<number> {
  const stampPath = join(repoRoot, WEB_UP_STAMP_PATH)
  const snapshot = await readSourceSnapshot(repoRoot)
  const stamp = await readWebUpStamp(stampPath)
  const artifactExists = existsSync(join(repoRoot, WEB_UP_ARTIFACT_PATH))
  if (needsWebRebuild({ stamp, snapshot, artifactExists })) {
    for (const step of [['clean'], ['install'], ['run', 'build']] as const) {
      const code = await runPnpm(step, environment)
      if (code !== 0) return code
    }
    await writeWebUpStamp(stampPath, await readSourceSnapshot(repoRoot))
  }
  return runPnpm(['dsh', 'web', ...args], { ...environment, DSH_HOME: WEB_UP_DSH_HOME })
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) {
  process.exit(await runWebUp(process.argv.slice(2)))
}
