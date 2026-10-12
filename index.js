/**
 * @module @local/dashin-learning
 *
 * Stable shell for the learning plugin.
 *
 * This file registers capabilities — the agent tool, the system-prompt section,
 * and the HTTP API behind `connection`'s trust fence — and owns nothing else.
 * The behaviour lives in `host/impl.js`, which is re-imported whenever its mtime
 * changes, so implementation edits take effect immediately instead of needing an
 * app restart. The static import below is the always-available fallback: if the
 * dynamic reload ever fails, the plugin keeps working with the generation that
 * was loaded at startup.
 *
 * Because of that reload, keep this file boring and keep `host/impl.js`
 * stateless — each reload builds a brand-new module instance.
 *
 * Imports node builtins only: a profile-installed bundle resolves
 * `@deepseek-ai/*` from the dsh installation, not from the profile.
 */

import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import * as startupImpl from './host/impl.js'

export const name = 'dashin-learning'
export const inject = ['tools']

const API_PATH = '/dashin/api'
const CONTAINER_DIR = 'learning'
const SHELL_LOADED_AT = new Date().toISOString()
const MAX_BODY_BYTES = 4 * 1024 * 1024
const IMPL_URL = new URL('./host/impl.js', import.meta.url)

/* ------------------------------------------------------- live impl load */

let cache = { mtimeMs: -1, mod: startupImpl }
let pending = null

/**
 * The current implementation generation. Re-imports `host/impl.js` with a
 * cache-busting query whenever the file's mtime changes; falls back to the last
 * good generation so a broken edit can never take the plugin down.
 */
async function impl() {
  try {
    const info = await stat(IMPL_URL)
    if (info.mtimeMs === cache.mtimeMs) return cache.mod
    if (pending === null) {
      const mtimeMs = info.mtimeMs
      pending = import(`${IMPL_URL.href}?v=${mtimeMs}`)
        .then((mod) => {
          cache = { mtimeMs, mod }
          return mod
        })
        .finally(() => {
          pending = null
        })
    }
    return await pending
  } catch {
    return cache.mod
  }
}

/* ------------------------------------------------------------------ utils */

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : value === undefined || value === null ? fallback : String(value)
}

function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  return text === '' ? {} : JSON.parse(text)
}

/** Same-origin trust gate, mirroring the shipped route handlers. */
function isRejected(ctx, req, res) {
  const connection = ctx.get('connection')
  const rejection = connection?.requestRejection?.(req)
  if (rejection === undefined || rejection === null || rejection === false) return false
  res.statusCode = typeof rejection === 'number' ? rejection : 403
  res.end()
  return true
}

function toolText(value) {
  let text
  try {
    text = JSON.stringify(value, null, 2)
  } catch {
    text = String(value)
  }
  return text.length > 8000 ? `${text.slice(0, 8000)}\n…（已截断）` : text
}

/* ------------------------------------------------------ project location */

/**
 * Resolve the learning CONTAINER directory (one subdirectory per project).
 * Precedence: explicit config, the current session's workspace, the first
 * registered workspace, DSH_WORKSPACE, then the process directory.
 */
function makeResolver(ctx, config) {
  return () => {
    const explicit = asString(config?.projectsDir).trim()
    if (explicit) return { dir: resolve(explicit), source: 'config' }

    const registry = ctx.get('workspaceRegistry')
    if (registry !== undefined && typeof registry.list === 'function') {
      const workspaces = registry.list()
      const sessionId = process.env.DSH_SESSION_ID
      if (sessionId) {
        const owner = workspaces.find((w) => Array.isArray(w.sessionIds) && w.sessionIds.includes(sessionId))
        if (owner?.path) return { dir: join(owner.path, CONTAINER_DIR), source: 'workspace(session)', base: owner.path }
      }
      if (workspaces.length > 0 && workspaces[0]?.path) {
        return { dir: join(workspaces[0].path, CONTAINER_DIR), source: 'workspace', base: workspaces[0].path }
      }
    }

    const fromEnv = asString(process.env.DSH_WORKSPACE).trim()
    if (fromEnv) return { dir: join(resolve(fromEnv), CONTAINER_DIR), source: 'env', base: resolve(fromEnv) }
    return { dir: join(process.cwd(), CONTAINER_DIR), source: 'cwd', base: process.cwd() }
  }
}

/* ----------------------------------------------------------- agent tool */

const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      description:
        '动作名。动作很多，完整清单与参数说明请调用 learning({action:"help"})；未知动作会直接把清单返回给你。' +
        '常用：status / practice_due 读真实进度，project_create 建项目，chapter_upsert + kp_upsert 建章节与知识点，' +
        'quiz + quiz_answer 出题与作答，material_add 落盘资料，progress_log 记流水。',
    },
    projectId: {
      type: 'string',
      description: '目标学习项目的 id（就是 learning/ 下的目录名）。项目内动作省略时作用于当前项目；多个项目时建议显式指定。',
    },
    id: { type: 'string', description: '目标对象 id（章节 / 任务 / 资料 / 复习项）' },
    title: { type: 'string', description: '标题（项目 / 章节 / 资料 / 任务）' },
    markdown: { type: 'string', description: 'markdown 正文（plan_write / outline_write / exercise_write / material_add）' },
    mode: { type: 'string', enum: ['replace', 'append'], description: '文档写入方式，默认 replace' },
    source: { type: 'string', description: '资料出处，例如上传的文件名或 URL' },
    kind: { type: 'string', description: '资料类型，例如 pdf / docx / slides / note' },
    summary: { type: 'string', description: '摘要或章节说明' },
    goal: { type: 'string', description: '项目学习目标（project_create）' },
    subject: { type: 'string', description: '科目（project_create）' },
    force: { type: 'boolean', description: 'init 或 project_create 时是否覆盖已存在的文件' },
    confirm: { type: 'boolean', description: 'project_delete 必须显式传 true，否则拒绝执行' },
    chapter: { type: 'object', description: '章节字段：{ id?, title?, order?, status?, progress?, summary? }' },
    patch: { type: 'object', description: 'task_update 要更新的字段' },
    task: { type: 'object', description: '任务字段：{ title, chapterId?, status?, priority?, due?, estimateMin?, note? }' },
    chapterId: { type: 'string', description: '所属章节 id' },
    chapterIds: { type: 'array', items: { type: 'string' }, description: '资料关联的章节 id 列表' },
    taskId: { type: 'string', description: '关联任务 id' },
    grade: { type: 'string', enum: ['again', 'hard', 'good', 'easy'], description: '复习评分：again 忘记了 / hard 勉强 / good 记得 / easy 太简单' },
    due: { type: 'string', description: '任务截止 / 复习日期 YYYY-MM-DD' },
    horizonDays: { type: 'number', description: 'review_due 的展望天数，默认 7' },
    minutes: { type: 'number', description: '本次学习或复习用时（分钟）' },
    note: { type: 'string', description: '备注' },
    status: { type: 'string', description: '状态：章节 todo|doing|done|review，任务 todo|doing|done' },
    priority: { type: 'string', enum: ['low', 'normal', 'high'], description: '任务优先级' },
    progress: { type: 'number', description: '章节进度 0-100' },
    estimateMin: { type: 'number', description: '任务预估用时（分钟）' },
    // Knowledge-point and quiz surface. Only the common fields are projected
    // here; `learning({action:'help'})` is the authority for the full contract,
    // which is why adding an action needs no shell change.
    knowledgePointId: { type: 'string', description: '知识点 id（出题、评估、复习都按它定位）' },
    kp: { type: 'object', description: '知识点：{ id?, name, type: memory|concept|procedure|design, prerequisiteIds?, sourceIds? }' },
    learner: { type: 'object', description: '学习者画像：{ priorKnowledge, targetLevel, timeBudget, preferences, teachingStrategy, notes }' },
    stage: { type: 'string', description: '章节阶段：diagnostic|explain|feynman_check|practice|error_diagnosis|review|completed' },
    objective: { type: 'string', description: '模块目标（章节级）' },
    passThreshold: { type: 'number', description: '章节达标阈值，默认 0.7' },
    prompt: { type: 'string', description: '题干（quiz）' },
    expectedAnswer: { type: 'string', description: '正确答案（quiz）：存在 Host 上，用于确定性评分' },
    acceptedAnswers: { type: 'array', items: { type: 'string' }, description: '其他可接受答案' },
    options: { type: 'array', description: '选择题选项：[{ label, body }] 或 ["选项一", ...]' },
    explanation: { type: 'string', description: '解析（评分后才回传）' },
    questionType: { type: 'string', enum: ['short', 'choice', 'numeric', 'boolean'], description: '题型' },
    matchMode: { type: 'string', enum: ['auto', 'exact', 'numeric', 'contains'], description: '评分匹配方式，默认 auto' },
    answer: { type: 'string', description: '学习者的作答（quiz_answer）' },
    hintsUsed: { type: 'number', description: '这次作答用了几次提示（会削弱证据强度）' },
    selfAttribution: { type: 'string', description: '学习者对错因的自述' },
    errorType: { type: 'string', enum: ['structural', 'deviation', 'application', 'metacognitive'], description: '错误类型' },
    sufficient: { type: 'boolean', description: 'assess：复述检验是否通过（仅 concept/design）' },
    deferred: { type: 'boolean', description: 'kp_defer：是否跳过该知识点（跳过不算掌握）' },
    revoke: { type: 'boolean', description: 'kp_override：撤销「声明已掌握」' },
    materialId: { type: 'string', description: '资料 id（reading_progress / note_add / note_remove）' },
    locator: { type: 'number', description: '阅读位置（段号）' },
    percent: { type: 'number', description: '阅读进度 0-1' },
    anchor: { type: 'string', description: '笔记锚点（引用的原文片段）' },
    text: { type: 'string', description: '笔记正文' },
    knowledgePointIds: { type: 'array', items: { type: 'string' }, description: '笔记关联的知识点' },
    desiredRetention: { type: 'number', description: '目标可提取性 0.7-0.99，默认 0.9' },
    // Folder association (the creation wizard's surface).
    dir: { type: 'string', description: '关联的文件夹绝对路径（project_scan / project_create）' },
    createDir: { type: 'boolean', description: 'project_create 时 dir 不存在是否创建，默认 true' },
    renameDir: { type: 'boolean', description: 'project_rename 是否连文件夹一起改名，默认 false（只改显示名）' },
    purge: { type: 'boolean', description: 'project_remove 是否真删文件夹（需同时传 confirm: true）' },
    rel: { type: 'string', description: '项目文件夹内的相对路径' },
    rels: { type: 'array', items: { type: 'string' }, description: '要导入的资料相对路径列表' },
    url: { type: 'string', description: '要抓取的网页地址（material_fetch）' },
    maxDepth: { type: 'number', description: 'project_scan 的递归深度，默认 2' },
    maxFiles: { type: 'number', description: 'project_scan 的文件数上限，默认 200' },
  },
  required: ['action'],
}

const TOOL_DESCRIPTION = `管理 DashinLearning 学习项目（只依赖文件，不依赖对话上下文）。

**动作清单与参数说明以 learning({action:"help"}) 为准**，未知动作会直接把清单返回给你。

一个学习项目就是**磁盘上的一个普通文件夹**（可以在任何位置，不限于工作区）。
同时存在 \`learning.md\` 与 \`learning.json\` 的文件夹，就是一个**标准 DashinLearning 项目**。
注册表在 \`<工作区>/learning/projects.json\`，记录每个项目的 id / 路径 / 标题。
每个项目内：
  learning.md / outline.md / exercises.md    markdown 内容：计划、大纲、练习题
  materials/<id>-<slug>.md                   markdown 正文：解析后的学习资料
  learning.json    学习者画像 + 章节 + 知识点（含题型、掌握度、阶段）
  reviews.json     间隔重复状态与复习证据     practice.json  出题记录 + 待答题 + 错题本
  materials.json   资料索引、阅读进度与笔记   tasks.json / progress.json

核心原则（来自 DeepTutor 的设计）：**模型决定教什么、怎么提问；能否进阶由确定性闸门决定。**
- 掌握度由测验证据算出（近因加权 + 置信度上限），不由谁声明；章节进度由知识点掌握度派生。
- 概念型 / 设计型走**复述检验**（assess 定性判定），记忆型 / 程序型看分数线（默认 0.7）。
- 出题用 quiz 把答案存在 Host，学习者作答后 quiz_answer 返回对错、正解与解析 ——
  你不需要记住答案，也不能事后修改它。
- 跳过（kp_defer）不算掌握；学习者可以 kp_override 声明已掌握，但单独记账、不污染证据。

标准流程（参考 DeepTutor）：
1. action=project_scan { dir } 识别文件夹：是否已是标准项目、里面有哪些可导入的资料。
2. action=project_create { dir?, title?, goal? } 建项目（省略 dir 就在容器下新建）。
   创建后该文件夹会注册成 DSH 工作区，出现在左侧工作区树里。
3. action=learner_set 采集画像；action=project_import_files 或 material_fetch 收集资料。
4. 依据资料 action=chapter_upsert 建章节（带 objective），kp_upsert 拆知识点，outline_write 写大纲。
5. action=quiz 出题 → 学习者作答 → action=quiz_answer 评分并推进掌握度与复习排期。
6. action=practice_due 拿到今天该练什么；action=progress_log 记录用时。

所有写入都是原子的；长内容一律存文件，不要把它塞回对话。`

/* --------------------------------------------------------- host services */

/**
 * The two capabilities the implementation cannot reach itself: registering a
 * DSH workspace, and fetching a URL. Both are optional, and both fail
 * descriptively rather than taking the plugin down.
 */
function hostServices(ctx) {
  return {
    async registerWorkspace(dir, title) {
      const registry = ctx.get('workspaceRegistry')
      if (registry === undefined || typeof registry.create !== 'function') return null
      const workspace = await registry.create(dir, title)
      return { id: String(workspace.id), title: workspace.title, path: workspace.path }
    },
    async fetchUrl(url, signal) {
      const web = ctx.get('web')
      if (web === undefined || typeof web.fetch !== 'function') {
        throw new Error('网络抓取不可用：当前 profile 没有 ctx.web 服务')
      }
      return web.fetch({ url }, signal)
    },
  }
}

function makeTool(ctx, resolveRoot, host) {
  return {
    name: 'learning',
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: {
      schema: { type: 'object' },
      render(_args, value) {
        return [{ type: 'text', text: toolText(value) }]
      },
    },
    async execute(args) {
      const root = resolveRoot()
      const live = await impl()
      return live.runAction(host, root, args ?? {})
    },
  }
}

/* ------------------------------------------------------------ http api */

function makeApiHandler(ctx, resolveRoot, host) {
  const hostInfo = async () => ({
    shellLoadedAt: SHELL_LOADED_AT,
    implMtimeMs: cache.mtimeMs,
    implRevision: cache.mod?.REVISION ?? null,
  })

  return async (req, res) => {
    if (isRejected(ctx, req, res)) return
    const url = new URL(String(req.url ?? '/'), 'http://localhost')
    const path = url.pathname
    const root = resolveRoot()

    try {
      if (req.method === 'GET' && path === `${API_PATH}/projects`) {
        const live = await impl()
        sendJson(res, 200, { ok: true, state: { ...(await live.viewProjects(root)), host: await hostInfo() } })
        return
      }

      if (req.method === 'GET' && path === `${API_PATH}/project`) {
        const live = await impl()
        const id = asString(url.searchParams.get('id'))
        sendJson(res, 200, { ok: true, state: { ...(await live.viewProject(root, id)), host: await hostInfo() } })
        return
      }

      if (req.method === 'GET' && path === `${API_PATH}/file`) {
        const live = await impl()
        sendJson(res, 200, {
          ok: true,
          doc: await live.readDoc(root, asString(url.searchParams.get('project')), asString(url.searchParams.get('path'))),
        })
        return
      }

      if (req.method === 'POST' && path === `${API_PATH}/action`) {
        const body = await readJsonBody(req)
        const live = await impl()
        sendJson(res, 200, { ok: true, result: await live.runAction(host, root, body) })
        return
      }

      sendJson(res, 404, { ok: false, error: `no learning api route for ${req.method} ${path}` })
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
}

/* -------------------------------------------------------------- apply */

/**
 * @param ctx - Host plugin context.
 * @param config - the Loader row's `config` (unvalidated; read defensively).
 */
export function apply(ctx, config = {}) {
  const resolveRoot = makeResolver(ctx, config ?? {})
  const host = hostServices(ctx)

  ctx.effect(() => ctx.tools.register(makeTool(ctx, resolveRoot, host)), 'dashin-learning: agent tool')

  ctx.inject(['systemPrompt'], (child) => {
    child.effect(
      () =>
        child.systemPrompt.section({
          name: 'local-learning-project',
          order: 60,
          text: () => {
            const root = resolveRoot()
            if (!existsSync(root.dir)) return ''
            try {
              return cache.mod.promptText(root)
            } catch {
              return startupImpl.promptText(root)
            }
          },
        }),
      'dashin-learning: prompt section',
    )
  })

  ctx.inject(['webServer'], (child) => {
    child.effect(
      () =>
        child.webServer.register({
          kind: 'prefix',
          path: API_PATH,
          handler: makeApiHandler(ctx, resolveRoot, host),
        }),
      `dashin-learning: http api at ${API_PATH}`,
    )
  })
}
