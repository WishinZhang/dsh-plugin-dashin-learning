/**
 * @module @local/dashin-learning/host-impl
 *
 * Implementation half of the learning plugin. `index.js` is a stable shell that
 * registers capabilities; every call re-loads THIS file when its mtime changes,
 * so logic edits take effect without restarting the app. Keep it STATELESS —
 * each reload builds a new module instance, so every fact lives on disk.
 *
 * ## Layout
 *
 *   learning/
 *   ├── current.json                 { version, projectId }
 *   └── <projectId>/                 projectId IS the directory name (a slug)
 *       ├── learning.json            { version, project, learner, chapters[] }
 *       ├── reviews.json             { version, desiredRetention, states, evidence }
 *       ├── practice.json            { version, pending, attempts, errors }
 *       ├── materials.json           { version, items[] }  each with reading + notes
 *       ├── tasks.json / progress.json
 *       ├── learning.md / outline.md / exercises.md
 *       └── materials/*.md
 *
 * The directory scan IS the project registry: there is no second list to drift.
 *
 * ## Where the intelligence sits
 *
 * Ported from DeepTutor (`deeptutor/learning/`, Apache-2.0, HKUDS): the model
 * decides what to teach and how to question, while whether the learner may
 * ADVANCE is a deterministic engine call in `./engine.js`. Chapter progress is
 * derived from knowledge-point evidence and cannot be asserted by a caller, and
 * a quiz grade is computed against an answer stored HERE, so the model never has
 * to recall — or gets to revise — what it asked.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

import {
  DAY_MS,
  DESIRED_RETENTION,
  ERROR_TYPES,
  INTERVAL_SEQUENCES,
  KNOWLEDGE_TYPES,
  QUALITATIVE_TYPES,
  STAGES,
  buildReviewQueue,
  canSetStage,
  chapterGate,
  chapterProgress,
  computeMastery,
  hydrate,
  initialRepetitionState,
  isQualitative,
  pointSatisfied,
  scheduleReview,
  toIso,
  toMs,
  validateDesiredRetention,
} from './engine.js'

export const REVISION = 3

const STATE_VERSION = 2
const MAX_LOG_ENTRIES = 2000
const MAX_ATTEMPTS_PER_POINT = 40
const MAX_STATE_DOC_CHARS = 6000
const MAX_BODY_BYTES = 4 * 1024 * 1024
const MAX_NOTE_CHARS = 4000

const CURRENT_FILE = 'current.json'
const REGISTRY_FILE = 'projects.json'
const MATERIALS_DIR = 'materials'

const PROJECT_FILES = {
  project: 'learning.json',
  materials: 'materials.json',
  tasks: 'tasks.json',
  progress: 'progress.json',
  reviews: 'reviews.json',
  practice: 'practice.json',
}

const DOC_FILES = {
  plan: 'learning.md',
  outline: 'outline.md',
  exercises: 'exercises.md',
}

const LEGACY_MARKERS = ['learning.json', 'tasks.json', 'reviews.json', 'learning.md']

const STAGE_LABEL = {
  diagnostic: '诊断',
  explain: '讲解',
  feynman_check: '复述检验',
  practice: '练习',
  error_diagnosis: '错因诊断',
  review: '复习',
  completed: '完成',
}

const STATUS_TO_STAGE = { todo: 'diagnostic', doing: 'explain', review: 'review', done: 'completed' }

function stageToStatus(stage) {
  if (stage === 'completed') return 'done'
  if (stage === 'review') return 'review'
  if (stage === 'diagnostic') return 'todo'
  return 'doing'
}

/* ------------------------------------------------------------------ utils */

const nowIso = () => new Date().toISOString()
const today = () => new Date().toISOString().slice(0, 10)

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`
}

function slugify(input, fallback = 'item') {
  const slug = String(input ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 48)
  return slug || fallback
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0))

function oneOf(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : value === undefined || value === null ? fallback : String(value)
}

function insideDir(parent, candidate) {
  const target = resolve(parent, candidate)
  const rel = relative(parent, target)
  if (rel === '') return target
  if (rel.startsWith('..') || isAbsolute(rel)) return undefined
  return target
}

/* ------------------------------------------------------------- file io */

async function readJson(file, fallback) {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : fallback
  } catch {
    return fallback
  }
}

async function writeText(file, text) {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, file)
}

async function writeJson(file, value) {
  await writeText(file, `${JSON.stringify(value, null, 2)}\n`)
}

async function readTextOr(file, fallback = '') {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return fallback
  }
}

/* --------------------------------------------------------------- grading */

const PUNCTUATION = /[。，、；：？！“”‘’（）【】《》,.;:?!"'()[\]<>]/g
const NUMERIC = /^-?\d+(?:\.\d+)?(?:\s*\/\s*-?\d+(?:\.\d+)?)?$/

/** Fold case, whitespace, and punctuation so "线性 无关。" matches "线性无关". */
export function normalizeAnswer(text) {
  return String(text ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(PUNCTUATION, '')
    .replace(/\s+/g, '')
}

function asNumber(text) {
  const value = String(text ?? '').trim()
  if (!NUMERIC.test(value)) return null
  if (value.includes('/')) {
    const [top, bottom] = value.split('/').map((part) => Number(part.trim()))
    if (!Number.isFinite(top) || !Number.isFinite(bottom) || bottom === 0) return null
    return top / bottom
  }
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/**
 * Deterministic grading against the answer stored on the Host. No model is
 * involved, and the same answer always grades the same way.
 * @returns {{ isCorrect: boolean, matchedBy: string }}
 */
export function gradeAnswer(question, answer) {
  const mode = question.matchMode ?? 'auto'
  const given = asString(answer)
  const candidates = [question.expectedAnswer, ...(question.acceptedAnswers ?? [])].filter(
    (value) => typeof value === 'string' && value !== '',
  )
  const normalizedGiven = normalizeAnswer(given)

  if (mode === 'exact') {
    return { isCorrect: candidates.some((value) => normalizeAnswer(value) === normalizedGiven), matchedBy: 'exact' }
  }
  if (mode === 'contains') {
    const ok = normalizedGiven.length > 0 && candidates.some((value) => {
      const normalized = normalizeAnswer(value)
      return normalized !== '' && normalizedGiven.includes(normalized)
    })
    return { isCorrect: ok, matchedBy: 'contains' }
  }

  // auto: exact, then numeric with tolerance, then containment.
  if (candidates.some((value) => normalizeAnswer(value) === normalizedGiven)) {
    return { isCorrect: true, matchedBy: 'exact' }
  }
  const givenNumber = asNumber(given)
  if (givenNumber !== null) {
    for (const value of candidates) {
      const expected = asNumber(value)
      if (expected !== null && Math.abs(expected - givenNumber) <= Math.max(1e-9, Math.abs(expected) * 1e-6)) {
        return { isCorrect: true, matchedBy: 'numeric' }
      }
    }
  }
  if (normalizedGiven.length >= 2) {
    const ok = candidates.some((value) => {
      const normalized = normalizeAnswer(value)
      return normalized.length >= 2 && normalizedGiven.includes(normalized)
    })
    if (ok) return { isCorrect: true, matchedBy: 'contains' }
  }
  return { isCorrect: false, matchedBy: 'none' }
}

/** The projection a learner (or the model) may see. The answer is never in it. */
export function publicQuestion(question) {
  if (question === null || question === undefined) return null
  const view = {
    id: question.id,
    chapterId: question.chapterId ?? null,
    knowledgePointId: question.knowledgePointId ?? null,
    prompt: question.prompt ?? '',
    type: question.type ?? 'short',
    options: Array.isArray(question.options) ? question.options : [],
    createdAt: question.createdAt ?? null,
    status: question.status ?? 'awaiting_input',
  }
  if (question.status === 'graded' && question.result) view.result = question.result
  return view
}

/* --------------------------------------------------------- project io */

function defaultProjectMeta() {
  return { title: '未命名学习项目', goal: '', subject: '', createdAt: nowIso(), updatedAt: nowIso() }
}

function defaultLearner() {
  return {
    priorKnowledge: '',
    targetLevel: '',
    timeBudget: '',
    preferences: '',
    teachingStrategy: 'probe_first',
    notes: '',
    updatedAt: null,
  }
}

/* ------------------------------------------------------------ registry */

/**
 * A project IS an arbitrary folder on disk, not a slug under the container —
 * the container only holds the registry and the projects we created ourselves.
 * `learning/<slug>/` is merely where a project created without an explicit
 * folder lands.
 */
async function loadRegistry(root) {
  const doc = await readJson(join(root.dir, REGISTRY_FILE), null)
  if (doc !== null && Array.isArray(doc.projects)) return doc.projects
  // First run: adopt every directory that already looks like a project, so a
  // collection built by an earlier generation keeps working untouched.
  let entries = []
  try {
    entries = await readdir(root.dir, { withFileTypes: true })
  } catch {
    entries = []
  }
  const adopted = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const dir = join(root.dir, entry.name)
    if (!existsSync(join(dir, PROJECT_FILES.project))) continue
    const project = await readJson(join(dir, PROJECT_FILES.project), null)
    adopted.push({
      id: entry.name,
      dir,
      title: project?.project?.title ?? entry.name,
      addedAt: nowIso(),
      standard: existsSync(join(dir, DOC_FILES.plan)),
      managed: true,
    })
  }
  await writeRegistry(root, adopted)
  return adopted
}

async function writeRegistry(root, projects, extra = {}) {
  await writeJson(join(root.dir, REGISTRY_FILE), { version: 1, projects, ...extra, updatedAt: nowIso() })
}

/**
 * A folder is a STANDARD DashinLearning project when it carries both marker
 * files. That is the whole test — nothing else is required, and a folder that
 * only has one of them counts as a plain folder to be initialised.
 */
function isStandardProject(dir) {
  return existsSync(join(dir, PROJECT_FILES.project)) && existsSync(join(dir, DOC_FILES.plan))
}

/** Resolve one registry entry, reporting a folder that has gone missing. */
async function lookupProject(root, projectId) {
  const id = asString(projectId).trim()
  if (id === '') return undefined
  const projects = await loadRegistry(root)
  const entry = projects.find((project) => project.id === id)
  if (entry === undefined) return undefined
  return { ...entry, exists: existsSync(join(entry.dir, PROJECT_FILES.project)) }
}

/** The directory a resolution must write into; throws when unusable. */
function requireDir(entry) {
  if (entry === undefined) throw new Error('unknown learning project')
  if (entry.exists === false) throw new Error(`项目文件夹已不存在：${entry.dir}`)
  return entry.dir
}

async function readCurrent(root) {
  const doc = await readJson(join(root.dir, CURRENT_FILE), null)
  const id = asString(doc?.projectId).trim()
  return id === '' ? null : id
}

async function writeCurrent(root, projectId) {
  await writeJson(join(root.dir, CURRENT_FILE), { version: 1, projectId, updatedAt: nowIso() })
}

/* ----------------------------------------------------------- folder scan */

const TEXT_EXTENSIONS = ['.md', '.markdown', '.txt', '.text', '.rst', '.org']
const BINARY_EXTENSIONS = ['.pdf', '.docx', '.doc', '.pptx', '.ppt', '.xlsx', '.xls', '.epub']
const SKIP_DIRECTORIES = new Set(['.git', 'node_modules', '.obsidian', '.trash', '__pycache__', '.venv'])

function classifyFile(name) {
  const lower = name.toLowerCase()
  if (TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension))) return 'text'
  if (BINARY_EXTENSIONS.some((extension) => lower.endsWith(extension))) return 'binary'
  return 'other'
}

/**
 * Inspect a folder without writing anything: is it already a standard project,
 * and what could be imported as material? Depth- and count-bounded.
 */
export async function scanFolder(dir, options = {}) {
  const maxDepth = Number.isFinite(Number(options.maxDepth)) ? Number(options.maxDepth) : 2
  const maxFiles = Number.isFinite(Number(options.maxFiles)) ? Number(options.maxFiles) : 200
  if (!existsSync(dir)) {
    return { dir, exists: false, isStandard: false, files: [], truncated: false }
  }
  const files = []
  let truncated = false

  const walk = async (current, depth) => {
    let entries = []
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true
        return
      }
      if (entry.name.startsWith('.')) continue
      const full = join(current, entry.name)
      const rel = relative(dir, full)
      if (entry.isDirectory()) {
        if (SKIP_DIRECTORIES.has(entry.name) || depth >= maxDepth) continue
        await walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      const kind = classifyFile(entry.name)
      if (kind === 'other') continue
      let size = 0
      try {
        size = (await stat(full)).size
      } catch {
        size = 0
      }
      files.push({ rel, name: entry.name, kind, size })
    }
  }

  await walk(dir, 0)
  files.sort((a, b) => a.rel.localeCompare(b.rel))
  return {
    dir,
    exists: true,
    isStandard: isStandardProject(dir),
    hasLearningJson: existsSync(join(dir, PROJECT_FILES.project)),
    hasLearningMd: existsSync(join(dir, DOC_FILES.plan)),
    empty: files.length === 0,
    files,
    truncated,
  }
}

/* --------------------------------------------------------- html → md */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…' }

function decodeEntities(text) {
  return text
    .replace(/&#(\d+);/g, (_m, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (match, name) => ENTITIES[name.toLowerCase()] ?? match)
}

/**
 * A deliberately small HTML→Markdown reducer: headings, lists, quotes, code,
 * links and emphasis. Enough to turn a documentation page into readable study
 * material, and no more — anything richer belongs to the model.
 */
export function htmlToMarkdown(html) {
  let text = String(html ?? '')
  text = text.replace(/<!--[\s\S]*?-->/g, '')
  text = text.replace(/<(script|style|noscript|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
  text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, body) => `\n\n\`\`\`\n${body.replace(/<[^>]+>/g, '')}\n\`\`\`\n\n`)
  text = text.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, (_m, body) => `\`${body.replace(/<[^>]+>/g, '')}\``)
  for (let level = 6; level >= 1; level -= 1) {
    text = text.replace(new RegExp(`<h${level}[^>]*>([\\s\\S]*?)</h${level}>`, 'gi'), (_m, body) => `\n\n${'#'.repeat(level)} ${body}\n\n`)
  }
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, body) => `\n- ${body.trim()}`)
  text = text.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, body) => `\n\n> ${body.trim()}\n\n`)
  text = text.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**')
  text = text.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*')
  text = text.replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, body) => {
    const label = body.replace(/<[^>]+>/g, '').trim()
    return label === '' ? '' : `[${label}](${href})`
  })
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/(p|div|section|article|tr|h[1-6]|ul|ol|table)>/gi, '\n\n')
  text = text.replace(/<td[^>]*>/gi, ' | ')
  text = text.replace(/<[^>]+>/g, '')
  text = decodeEntities(text)
  return text
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function htmlTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ''))
  return match === null ? '' : decodeEntities(match[1].replace(/<[^>]+>/g, '').trim())
}

/* --------------------------------------------------------- conversion */

/** Turn one fetched page into a material-ready markdown document. */
export function fetchedToMarkdown(url, result) {
  const body = result?.body ?? {}
  if (body.kind === 'text') {
    return { markdown: String(body.content ?? '').trim(), title: '' }
  }
  return { markdown: htmlToMarkdown(body.content), title: htmlTitle(body.content) }
}

/* --------------------------------------------------------- migration v1 */

function migrateReviewItem(item, nowMs, index) {
  const kpId = `kp_${slugify(item.item, 'point')}_${index}`
  const history = Array.isArray(item.history) ? item.history : []
  const attempts = history.map((entry) => entry.grade === 'good' || entry.grade === 'easy')
  const intervalDays = Math.max(0, Number(item.intervalDays) || 0)
  const sequences = INTERVAL_SEQUENCES.memory
  let intervalIndex = 0
  let best = Infinity
  for (let position = 0; position < sequences.length; position += 1) {
    const distance = Math.abs(sequences[position] - intervalDays)
    if (distance < best) {
      best = distance
      intervalIndex = position
    }
  }
  const dueMs = toMs(item.due) ?? nowMs
  const lastMs = item.lastAt ? toMs(item.lastAt) : null
  const state = hydrate(
    {
      ...initialRepetitionState('memory', nowMs, DESIRED_RETENTION.default),
      intervalIndex,
      reviewCount: Math.max(0, Number(item.reps) || attempts.length || 0),
      lapseCount: Math.max(0, Number(item.lapses) || 0),
      nextReviewAt: toIso(dueMs),
      lastScheduledAt: toIso(lastMs ?? nowMs),
      lastReviewAt: lastMs === null ? null : toIso(lastMs),
    },
    'memory',
  )
  return {
    point: {
      id: kpId,
      name: asString(item.item) || '未命名知识点',
      type: 'memory',
      prerequisiteIds: [],
      sourceIds: [],
      mastery: computeMastery(attempts),
      qualitative: false,
      deferred: false,
      override: null,
      attempts,
      updatedAt: nowIso(),
    },
    state,
    evidence: history.map((entry) => ({
      id: newId('ev'),
      knowledgePointId: kpId,
      at: asString(entry.at) || nowIso(),
      source: 'migration',
      assessmentType: 'review',
      result: entry.grade === 'again' ? 'incorrect' : entry.grade === 'hard' ? 'partial' : 'correct',
      quality: null,
      hintsUsed: 0,
      attemptCount: 1,
    })),
    chapterId: asString(item.chapterId) || null,
  }
}

function emptyChapter(overrides = {}) {
  const chapter = {
    id: newId('ch'),
    title: '未命名章节',
    order: 0,
    objective: '',
    passThreshold: 0.7,
    stage: 'diagnostic',
    summary: '',
    materialIds: [],
    knowledgePoints: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
    completedAt: null,
    ...overrides,
  }
  chapter.status = stageToStatus(chapter.stage)
  chapter.progress = chapterProgress(chapter)
  return chapter
}

/**
 * Upgrade a v1 project in place and return the migrated documents so the caller
 * never reads a stale pre-migration snapshot. Idempotent: a project already at
 * the current version is returned untouched.
 */
async function migrateProject(dir, projectDoc, reviewsDoc, materialsDoc) {
  if (Number(projectDoc.version ?? 1) >= STATE_VERSION) {
    return { project: projectDoc, reviews: reviewsDoc, materials: materialsDoc }
  }

  const nowMs = Date.now()
  const legacyItems = Array.isArray(reviewsDoc?.items) ? reviewsDoc.items : []

  const states = {}
  const evidence = []
  const byChapter = new Map()
  legacyItems.forEach((item, index) => {
    const migrated = migrateReviewItem(item, nowMs, index)
    states[migrated.point.id] = migrated.state
    evidence.push(...migrated.evidence)
    if (!byChapter.has(migrated.chapterId)) byChapter.set(migrated.chapterId, [])
    byChapter.get(migrated.chapterId).push(migrated.point)
  })

  const chapters = (Array.isArray(projectDoc.chapters) ? projectDoc.chapters : []).map((chapter) =>
    emptyChapter({
      id: asString(chapter.id) || newId('ch'),
      title: asString(chapter.title) || '未命名章节',
      order: Number(chapter.order) || 0,
      objective: asString(chapter.objective),
      passThreshold: Number(chapter.passThreshold) > 0 ? Number(chapter.passThreshold) : 0.7,
      stage: STAGES.includes(chapter.stage) ? chapter.stage : STATUS_TO_STAGE[chapter.status] ?? 'diagnostic',
      summary: asString(chapter.summary),
      materialIds: Array.isArray(chapter.materialIds) ? chapter.materialIds : [],
      knowledgePoints: byChapter.get(chapter.id) ?? [],
      createdAt: chapter.createdAt ?? nowIso(),
      completedAt: chapter.completedAt ?? null,
    }),
  )

  // Legacy review items whose chapter no longer exists keep their own module so
  // no knowledge point is silently dropped.
  for (const [chapterId, points] of byChapter.entries()) {
    if (points.length === 0) continue
    if (chapterId !== null && chapters.some((chapter) => chapter.id === chapterId)) continue
    chapters.push(
      emptyChapter({
        id: chapterId ?? newId('ch'),
        title: chapterId === null ? '未归类知识点' : `未归类：${chapterId}`,
        order: chapters.length + 1,
        summary: '由旧版复习项自动迁移',
        knowledgePoints: points,
      }),
    )
  }

  const project = {
    version: STATE_VERSION,
    project: { ...defaultProjectMeta(), ...(projectDoc.project ?? {}), updatedAt: nowIso() },
    learner: { ...defaultLearner(), ...(projectDoc.learner ?? {}) },
    desiredRetention: validateDesiredRetention(projectDoc.desiredRetention ?? reviewsDoc?.desiredRetention ?? 0.9),
    chapters,
  }
  const reviews = {
    version: STATE_VERSION,
    desiredRetention: project.desiredRetention,
    states,
    evidence,
  }
  const materials = {
    version: STATE_VERSION,
    items: (Array.isArray(materialsDoc?.items) ? materialsDoc.items : []).map((item) => ({
      ...item,
      reading: item.reading ?? { locator: 1, percent: 0, furthestLocator: 1, furthestPercent: 0, updatedAt: null },
      notes: Array.isArray(item.notes) ? item.notes : [],
    })),
  }

  await writeJson(join(dir, PROJECT_FILES.project), project)
  await writeJson(join(dir, PROJECT_FILES.reviews), reviews)
  await writeJson(join(dir, PROJECT_FILES.materials), materials)
  if (!existsSync(join(dir, PROJECT_FILES.practice))) {
    await writeJson(join(dir, PROJECT_FILES.practice), { version: 1, pending: null, attempts: [], errors: [] })
  }

  return { project, reviews, materials }
}

/* -------------------------------------------------------------- loading */

async function loadRaw(dir) {
  const [projectDoc, materialsDoc, tasksDoc, progressDoc, reviewsDoc, practiceDoc] = await Promise.all([
    readJson(join(dir, PROJECT_FILES.project), null),
    readJson(join(dir, PROJECT_FILES.materials), null),
    readJson(join(dir, PROJECT_FILES.tasks), null),
    readJson(join(dir, PROJECT_FILES.progress), null),
    readJson(join(dir, PROJECT_FILES.reviews), null),
    readJson(join(dir, PROJECT_FILES.practice), null),
  ])

  let project = projectDoc
  let reviews = reviewsDoc
  let materials = materialsDoc
  if (projectDoc !== null && Number(projectDoc.version ?? 1) < STATE_VERSION) {
    const migrated = await migrateProject(dir, projectDoc, reviewsDoc, materialsDoc)
    project = migrated.project
    reviews = migrated.reviews
    materials = migrated.materials
  }

  return {
    exists: projectDoc !== null,
    version: Number(project?.version ?? STATE_VERSION),
    project: project?.project ?? defaultProjectMeta(),
    learner: project?.learner ?? defaultLearner(),
    desiredRetention: validateDesiredRetention(project?.desiredRetention ?? 0.9),
    chapters: Array.isArray(project?.chapters) ? project.chapters : [],
    materials: Array.isArray(materials?.items) ? materials.items : [],
    tasks: Array.isArray(tasksDoc?.items) ? tasksDoc.items : [],
    log: Array.isArray(progressDoc?.log) ? progressDoc.log : [],
    states: reviews?.states && typeof reviews.states === 'object' ? reviews.states : {},
    evidence: Array.isArray(reviews?.evidence) ? reviews.evidence : [],
    pending: practiceDoc?.pending ?? null,
    attempts: Array.isArray(practiceDoc?.attempts) ? practiceDoc.attempts : [],
    errors: Array.isArray(practiceDoc?.errors) ? practiceDoc.errors : [],
  }
}

const saveProject = (dir, raw) =>
  writeJson(join(dir, PROJECT_FILES.project), {
    version: STATE_VERSION,
    project: raw.project,
    learner: raw.learner,
    desiredRetention: raw.desiredRetention,
    chapters: raw.chapters,
  })
const saveMaterials = (dir, raw) =>
  writeJson(join(dir, PROJECT_FILES.materials), { version: STATE_VERSION, items: raw.materials })
const saveTasks = (dir, raw) =>
  writeJson(join(dir, PROJECT_FILES.tasks), { version: STATE_VERSION, items: raw.tasks })
const saveProgress = (dir, raw) =>
  writeJson(join(dir, PROJECT_FILES.progress), { version: STATE_VERSION, log: raw.log })
const saveReviews = (dir, raw) =>
  writeJson(join(dir, PROJECT_FILES.reviews), {
    version: STATE_VERSION,
    desiredRetention: raw.desiredRetention,
    states: raw.states,
    evidence: raw.evidence,
  })
const savePractice = (dir, raw) =>
  writeJson(join(dir, PROJECT_FILES.practice), {
    version: 1,
    pending: raw.pending,
    attempts: raw.attempts,
    errors: raw.errors,
  })

/* -------------------------------------------------------------- derived */

const byOrder = (a, b) =>
  (Number(a.order) || 0) - (Number(b.order) || 0) ||
  String(a.title ?? '').localeCompare(String(b.title ?? ''))

function flattenPoints(chapters) {
  const points = []
  for (const chapter of chapters) {
    for (const point of chapter.knowledgePoints ?? []) {
      points.push({ chapter, chapterId: chapter.id, chapterTitle: chapter.title, point })
    }
  }
  return points
}

function pointTypes(chapters) {
  const types = {}
  for (const chapter of chapters) {
    for (const point of chapter.knowledgePoints ?? []) types[point.id] = point.type
  }
  return types
}

function pointLabels(chapters) {
  const labels = {}
  for (const { point, chapter } of flattenPoints(chapters)) {
    labels[point.id] = { name: point.name, type: point.type, chapterId: chapter.id, chapterTitle: chapter.title }
  }
  return labels
}

function activeErrorIds(raw) {
  return new Set(
    raw.errors
      .filter((error) => error.status === 'active' || error.status === 'retrying')
      .map((error) => error.knowledgePointId),
  )
}

function reviewQueue(raw, nowMs) {
  return buildReviewQueue({
    nowMs,
    states: raw.states,
    types: pointTypes(raw.chapters),
    errorKpIds: activeErrorIds(raw),
  })
}

const ZERO_STATS = {
  chapters: 0,
  chaptersDone: 0,
  chaptersDoing: 0,
  chaptersReview: 0,
  chaptersBlocked: 0,
  progress: 0,
  knowledgePoints: 0,
  knowledgePointsMastered: 0,
  tasksOpen: 0,
  tasksDone: 0,
  materials: 0,
  notes: 0,
  reviews: 0,
  reviewsDue: 0,
  attempts: 0,
  attemptsCorrect: 0,
  errorsActive: 0,
  minutes: 0,
  todayMinutes: 0,
  logEntries: 0,
  lastAt: null,
}

function computeStats(raw) {
  const flat = flattenPoints(raw.chapters)
  const nowMs = Date.now()
  const dayKey = today()
  const minutes = raw.log.reduce((sum, entry) => sum + (Number(entry.minutes) || 0), 0)
  const todayMinutes = raw.log
    .filter((entry) => String(entry.at).slice(0, 10) === dayKey)
    .reduce((sum, entry) => sum + (Number(entry.minutes) || 0), 0)
  const queue = reviewQueue(raw, nowMs)
  const chapters = raw.chapters.map((chapter) => ({
    stage: chapter.stage,
    knowledgePoints: chapter.knowledgePoints ?? [],
    progress: chapterProgress(chapter),
    gate: chapterGate(chapter),
  }))
  return {
    chapters: chapters.length,
    chaptersDone: chapters.filter((chapter) => chapter.stage === 'completed').length,
    chaptersDoing: chapters.filter((chapter) =>
      ['explain', 'feynman_check', 'practice', 'error_diagnosis'].includes(chapter.stage),
    ).length,
    chaptersReview: chapters.filter((chapter) => chapter.stage === 'review').length,
    chaptersBlocked: chapters.filter(
      (chapter) => chapter.knowledgePoints.length > 0 && !chapter.gate.passed && chapter.stage !== 'diagnostic',
    ).length,
    progress: chapters.length ? Math.round(chapters.reduce((sum, chapter) => sum + chapter.progress, 0) / chapters.length) : 0,
    knowledgePoints: flat.length,
    knowledgePointsMastered: flat.filter(({ point, chapter }) => pointSatisfied(point, chapter.passThreshold ?? 0.7)).length,
    tasksOpen: raw.tasks.filter((task) => task.status !== 'done').length,
    tasksDone: raw.tasks.filter((task) => task.status === 'done').length,
    materials: raw.materials.length,
    notes: raw.materials.reduce((sum, item) => sum + (item.notes?.length ?? 0), 0),
    reviews: queue.length,
    reviewsDue: queue.filter((task) => toMs(task.dueAt) <= nowMs).length,
    attempts: raw.attempts.length,
    attemptsCorrect: raw.attempts.filter((attempt) => attempt.isCorrect).length,
    errorsActive: raw.errors.filter((error) => error.status === 'active' || error.status === 'retrying').length,
    minutes,
    todayMinutes,
    logEntries: raw.log.length,
    lastAt: raw.log.length ? String(raw.log[raw.log.length - 1].at) : null,
  }
}

function chapterView(chapter) {
  const threshold = Number(chapter.passThreshold) > 0 ? Number(chapter.passThreshold) : 0.7
  return {
    ...chapter,
    status: stageToStatus(chapter.stage),
    stageLabel: STAGE_LABEL[chapter.stage] ?? chapter.stage,
    progress: chapterProgress(chapter),
    gate: chapterGate(chapter),
    knowledgePoints: (chapter.knowledgePoints ?? []).map((point) => ({
      ...point,
      satisfied: pointSatisfied(point, threshold),
      qualitativeRequired: isQualitative(point.type),
    })),
  }
}

export async function viewProjects(root) {
  const entries = await loadRegistry(root)
  const projects = []
  for (const entry of entries) {
    const exists = existsSync(join(entry.dir, PROJECT_FILES.project))
    if (!exists) {
      projects.push({
        id: entry.id,
        title: entry.title ?? entry.id,
        dir: entry.dir,
        missing: true,
        standard: entry.standard === true,
        managed: entry.managed === true,
        workspaceId: entry.workspaceId ?? null,
        goal: '',
        subject: '',
        createdAt: entry.addedAt ?? null,
        updatedAt: entry.addedAt ?? null,
        stats: ZERO_STATS,
      })
      continue
    }
    const raw = await loadRaw(entry.dir)
    projects.push({
      id: entry.id,
      title: raw.project.title ?? entry.title ?? entry.id,
      dir: entry.dir,
      missing: false,
      standard: isStandardProject(entry.dir),
      managed: entry.managed === true,
      workspaceId: entry.workspaceId ?? null,
      goal: raw.project.goal ?? '',
      subject: raw.project.subject ?? '',
      createdAt: raw.project.createdAt ?? null,
      updatedAt: raw.project.updatedAt ?? null,
      stats: computeStats(raw),
    })
  }
  projects.sort(
    (a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')) || a.title.localeCompare(b.title),
  )
  const current = await readCurrent(root)
  return {
    root: root.dir,
    source: root.source,
    current: projects.some((project) => project.id === current) ? current : projects[0]?.id ?? null,
    count: projects.length,
    projects,
    legacy: LEGACY_MARKERS.some((file) => existsSync(join(root.dir, file))),
  }
}

export async function viewProject(root, projectId) {
  const id = asString(projectId).trim()
  const entry = await lookupProject(root, id)
  if (entry === undefined) throw new Error(`unknown learning project "${id}"`)
  const dir = requireDir(entry)
  const raw = await loadRaw(dir)
  const plan = await readTextOr(join(dir, DOC_FILES.plan))
  const nowMs = Date.now()
  const chapters = [...raw.chapters].sort(byOrder).map(chapterView)
  const labels = pointLabels(raw.chapters)
  const queue = reviewQueue(raw, nowMs)
  const decorate = (task) => ({ ...task, ...(labels[task.knowledgePointId] ?? {}) })

  return {
    root: root.dir,
    source: root.source,
    id,
    dir: entry.dir,
    standard: isStandardProject(dir),
    managed: entry.managed === true,
    workspaceId: entry.workspaceId ?? null,
    exists: raw.exists,
    version: raw.version,
    project: { ...raw.project, id },
    learner: raw.learner,
    desiredRetention: raw.desiredRetention,
    chapters,
    tasks: raw.tasks.map((task) => ({
      ...task,
      chapterTitle: chapters.find((chapter) => chapter.id === task.chapterId)?.title ?? null,
    })),
    materials: raw.materials.map((item) => ({
      ...item,
      reading: item.reading ?? { locator: 1, percent: 0, furthestLocator: 1, furthestPercent: 0, updatedAt: null },
      notes: Array.isArray(item.notes) ? item.notes : [],
    })),
    log: [...raw.log].reverse().slice(0, 50),
    stats: computeStats(raw),
    plan:
      plan.length > MAX_STATE_DOC_CHARS
        ? `${plan.slice(0, MAX_STATE_DOC_CHARS)}\n\n…（已截断，完整内容见 ${DOC_FILES.plan}）`
        : plan,
    docs: {
      plan: DOC_FILES.plan,
      outline: DOC_FILES.outline,
      exercises: DOC_FILES.exercises,
      outlineExists: existsSync(join(dir, DOC_FILES.outline)),
      exercisesExists: existsSync(join(dir, DOC_FILES.exercises)),
    },
    review: {
      queue: queue.map(decorate),
      due: queue.filter((task) => toMs(task.dueAt) <= nowMs).map(decorate),
      desiredRetention: raw.desiredRetention,
    },
    practice: {
      pending: publicQuestion(raw.pending),
      attempts: [...raw.attempts]
        .reverse()
        .slice(0, 30)
        .map((attempt) => ({ ...attempt, knowledgePointName: labels[attempt.knowledgePointId]?.name ?? null })),
      errors: raw.errors
        .filter((error) => error.status !== 'graduated')
        .map((error) => ({ ...error, knowledgePointName: labels[error.knowledgePointId]?.name ?? null }))
        .reverse()
        .slice(0, 50),
    },
    today: today(),
  }
}

export async function readDoc(root, projectId, relativePath) {
  const id = asString(projectId).trim()
  const entry = await lookupProject(root, id)
  if (entry === undefined) throw new Error(`unknown learning project "${id}"`)
  const dir = requireDir(entry)
  const allowed = Object.values(DOC_FILES)
  const requested = asString(relativePath)
  if (!allowed.includes(requested) && !requested.startsWith(`${MATERIALS_DIR}/`)) {
    throw new Error(`path must be one of ${allowed.join(', ')} or ${MATERIALS_DIR}/<file>.md`)
  }
  const full = insideDir(dir, requested)
  if (full === undefined) throw new Error('path escapes the project directory')
  return { projectId: id, path: requested, text: await readTextOr(full) }
}

/* ------------------------------------------------------------- templates */

function planTemplate(project) {
  return `# ${project.title}

> 学习计划总览。Agent 与人都从这里开始读。

## 目标

${project.goal || '（待填写：学完之后能做到什么）'}

## 学习方式

章节是一个**学习模块**，模块里拆成**知识点**；每个知识点有题型（记忆/概念/程序/设计）。
掌握度由测验证据算出来，不由谁声明；**闸门通过才能进入复习与完成**。
复习排期由可提取性衰减决定，遗忘风险高的先复习。

- 阶段：\`diagnostic 诊断\` → \`explain 讲解\` → \`feynman_check 复述检验\` → \`practice 练习\` → \`error_diagnosis 错因诊断\` → \`review 复习\` → \`completed 完成\`
- 概念型与设计型看**复述检验**（定性判定），记忆型与程序型看掌握度分数线

## 文件说明

| 文件 | 内容 |
|---|---|
| learning.md | 本文件：总览与计划 |
| outline.md | 大纲与章节规划 |
| exercises.md | 练习题与答案 |
| learning.json | 项目元信息 + 学习者画像 + 章节 + 知识点 |
| reviews.json | 间隔重复状态与复习证据 |
| practice.json | 出题记录、待答题、错题本 |
| materials.json + materials/ | 资料索引、正文、阅读进度与笔记 |
| tasks.json | 学习任务 |
| progress.json | 学习流水 |
`
}

function outlineTemplate() {
  return `# 大纲

> 章节规划。章节与知识点的结构化状态在 \`learning.json\`，这里放知识内容与学习路径。

## 第一章

**模块目标**：学完能做什么

- 知识点（记忆型）— 需要背下来的事实
- 知识点（概念型）— 需要能讲清楚，由复述检验判定
- 知识点（程序型）— 需要能按步骤做对
- 知识点（设计型）— 需要能做权衡与设计，由复述检验判定
`
}

function exercisesTemplate() {
  return `# 练习题

> 按章节分节。真正用于评分与掌握度统计的题目通过 \`learning\` 的 \`quiz\` 动作出题并落盘，
> 这个文件放需要长期保留、供人阅读的题目与解答。

## 第一章

1. 题目

<details>
<summary>答案</summary>

解答

</details>
`
}

/* ------------------------------------------------------- project actions */

async function appendLog(dir, raw, entry) {
  const record = {
    id: newId('p'),
    at: nowIso(),
    kind: entry.kind ?? 'study',
    chapterId: entry.chapterId ?? null,
    taskId: entry.taskId ?? null,
    knowledgePointId: entry.knowledgePointId ?? null,
    minutes: Math.max(0, Math.round(Number(entry.minutes) || 0)),
    note: asString(entry.note),
  }
  raw.log.push(record)
  if (raw.log.length > MAX_LOG_ENTRIES) raw.log = raw.log.slice(-MAX_LOG_ENTRIES)
  await saveProgress(dir, raw)
  return record
}

function findChapter(raw, chapterId) {
  return raw.chapters.find((chapter) => chapter.id === asString(chapterId))
}

function findPoint(raw, pointId) {
  const id = asString(pointId)
  for (const chapter of raw.chapters) {
    const point = (chapter.knowledgePoints ?? []).find((candidate) => candidate.id === id)
    if (point !== undefined) return { chapter, point }
  }
  return undefined
}

/** Record one graded outcome: mastery history, review schedule, error book. */
async function recordOutcome(dir, raw, entry) {
  const found = findPoint(raw, entry.knowledgePointId)
  if (found === undefined) throw new Error(`unknown knowledge point "${entry.knowledgePointId}"`)
  const { chapter, point } = found
  const type = KNOWLEDGE_TYPES.includes(point.type) ? point.type : 'memory'

  const isCorrect = entry.result === 'correct'
  point.attempts = [...(point.attempts ?? []), isCorrect].slice(-MAX_ATTEMPTS_PER_POINT)
  point.mastery = computeMastery(point.attempts)
  point.updatedAt = nowIso()
  chapter.updatedAt = nowIso()

  const evidence = {
    id: newId('ev'),
    knowledgePointId: point.id,
    at: nowIso(),
    source: entry.source ?? 'mastery_path',
    assessmentType: entry.assessmentType ?? 'quiz',
    result: entry.result,
    quality: entry.quality ?? null,
    hintsUsed: Number(entry.hintsUsed) || 0,
    attemptCount: Number(entry.attemptCount) || 1,
  }
  raw.evidence.push(evidence)
  if (raw.evidence.length > 4000) raw.evidence = raw.evidence.slice(-4000)
  raw.states[point.id] = scheduleReview(
    raw.states[point.id] ?? initialRepetitionState(type, Date.now(), raw.desiredRetention),
    type,
    { ...evidence, timestamp: evidence.at },
    Date.now(),
  )

  let error = raw.errors.find(
    (candidate) => candidate.knowledgePointId === point.id && candidate.status !== 'graduated',
  )
  if (!isCorrect) {
    if (error === undefined) {
      error = {
        id: newId('err'),
        knowledgePointId: point.id,
        chapterId: chapter.id,
        questionId: entry.questionId ?? null,
        errorType: oneOf(entry.errorType, ERROR_TYPES, 'application'),
        selfAttribution: asString(entry.selfAttribution),
        aiConfirmation: asString(entry.aiConfirmation),
        retryHistory: [],
        status: 'active',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      }
      raw.errors.push(error)
    } else {
      if (entry.errorType !== undefined) error.errorType = oneOf(entry.errorType, ERROR_TYPES, error.errorType)
      if (entry.selfAttribution !== undefined) error.selfAttribution = asString(entry.selfAttribution)
      error.status = 'retrying'
      error.updatedAt = nowIso()
    }
    error.retryHistory = [
      ...(error.retryHistory ?? []),
      { at: nowIso(), isCorrect: false, attemptNumber: (error.retryHistory?.length ?? 0) + 1 },
    ].slice(-30)
  } else if (error !== undefined) {
    error.retryHistory = [
      ...(error.retryHistory ?? []),
      { at: nowIso(), isCorrect: true, attemptNumber: (error.retryHistory?.length ?? 0) + 1 },
    ].slice(-30)
    error.status = 'graduated'
    error.updatedAt = nowIso()
  }

  // A satisfied module leaves practice and enters spaced review on its own.
  if (chapter.stage === 'practice' || chapter.stage === 'error_diagnosis') {
    if (chapterGate(chapter).passed) chapter.stage = 'review'
  }
  chapter.status = stageToStatus(chapter.stage)
  chapter.progress = chapterProgress(chapter)

  await saveProject(dir, raw)
  await saveReviews(dir, raw)
  await savePractice(dir, raw)

  return {
    knowledgePointId: point.id,
    knowledgePointName: point.name,
    mastery: point.mastery,
    attemptCount: point.attempts.length,
    satisfied: pointSatisfied(point, chapter.passThreshold ?? 0.7),
    state: raw.states[point.id],
    gate: chapterGate(chapter),
    chapterStage: chapter.stage,
    error: error === undefined ? null : { id: error.id, status: error.status, errorType: error.errorType },
  }
}

async function applyProjectAction(host, root, id, input, dir) {
  const action = asString(input?.action)
  const raw = await loadRaw(dir)
  const nowMs = Date.now()
  const touch = async () => {
    raw.project.updatedAt = nowIso()
    await saveProject(dir, raw)
  }

  switch (action) {
    case 'state':
      return viewProject(root, id)

    case 'init':
      return initProjectAt(dir, id, input)

    case 'learner_set': {
      const patch = input.learner && typeof input.learner === 'object' ? input.learner : input
      const learner = { ...raw.learner }
      for (const key of ['priorKnowledge', 'targetLevel', 'timeBudget', 'preferences', 'notes']) {
        if (patch[key] !== undefined) learner[key] = asString(patch[key])
      }
      if (patch.teachingStrategy !== undefined) {
        learner.teachingStrategy = oneOf(patch.teachingStrategy, ['probe_first', 'teach_first'], learner.teachingStrategy)
      }
      learner.updatedAt = nowIso()
      raw.learner = learner
      if (input.desiredRetention !== undefined) raw.desiredRetention = validateDesiredRetention(input.desiredRetention)
      raw.project.updatedAt = nowIso()
      await saveProject(dir, raw)
      return { projectId: id, learner: raw.learner, desiredRetention: raw.desiredRetention }
    }

    case 'plan_write':
    case 'outline_write':
    case 'exercise_write': {
      const file =
        action === 'plan_write' ? DOC_FILES.plan : action === 'outline_write' ? DOC_FILES.outline : DOC_FILES.exercises
      const markdown = asString(input.markdown)
      if (!markdown.trim()) throw new Error(`${action} requires markdown`)
      const full = join(dir, file)
      const existing = await readTextOr(full)
      const append = input.mode === 'append'
      const head = append ? (existing === '' || existing.endsWith('\n') ? existing : `${existing}\n`) : ''
      const tail = markdown.endsWith('\n') ? markdown : `${markdown}\n`
      await writeText(full, `${head}${tail}`)
      if (raw.exists) await touch()
      return { projectId: id, file, chars: (head + tail).length, mode: append ? 'append' : 'replace' }
    }

    case 'chapter_upsert': {
      const source = input.chapter && typeof input.chapter === 'object' ? input.chapter : input
      const chapterId = asString(source.id ?? input.id)
      let chapter = chapterId ? findChapter(raw, chapterId) : undefined
      const isNew = chapter === undefined
      if (isNew) {
        chapter = emptyChapter({ title: asString(source.title ?? input.title) || '未命名章节', order: raw.chapters.length + 1 })
        raw.chapters.push(chapter)
      }
      if (source.title !== undefined) chapter.title = asString(source.title)
      if (source.order !== undefined) chapter.order = Number(source.order) || chapter.order
      if (source.summary !== undefined) chapter.summary = asString(source.summary)
      if (source.objective !== undefined) chapter.objective = asString(source.objective)
      if (source.passThreshold !== undefined) chapter.passThreshold = clamp(source.passThreshold, 0.1, 1)
      // Both the friendly `status` shortcut and the explicit `stage` go through
      // the same gate: no caller may advance a module by asserting a status.
      const requestedStage =
        source.stage !== undefined
          ? asString(source.stage)
          : source.status !== undefined
            ? STATUS_TO_STAGE[source.status]
            : undefined
      if (requestedStage !== undefined) {
        const check = canSetStage(chapter, requestedStage)
        if (!check.allowed) {
          const names = (check.gate?.blocked ?? []).map((point) => point.name).join('、')
          throw new Error(`闸门未通过，不能进入「${STAGE_LABEL[requestedStage] ?? requestedStage}」${names ? `：未达标 ${names}` : ''}`)
        }
        chapter.stage = requestedStage
      }
      chapter.completedAt = chapter.stage === 'completed' ? chapter.completedAt ?? nowIso() : null
      chapter.status = stageToStatus(chapter.stage)
      chapter.progress = chapterProgress(chapter)
      chapter.updatedAt = nowIso()
      await touch()
      return { projectId: id, chapter: chapterView(chapter), created: isNew }
    }

    case 'chapter_remove': {
      const chapterId = asString(input.id)
      const chapter = findChapter(raw, chapterId)
      if (chapter === undefined) throw new Error(`unknown chapter "${chapterId}"`)
      raw.chapters = raw.chapters.filter((candidate) => candidate.id !== chapterId)
      for (const point of chapter.knowledgePoints ?? []) {
        delete raw.states[point.id]
        raw.errors = raw.errors.filter((error) => error.knowledgePointId !== point.id)
      }
      await saveReviews(dir, raw)
      await savePractice(dir, raw)
      await touch()
      return { projectId: id, removed: chapterId, chapters: raw.chapters.length }
    }

    case 'stage_set': {
      const chapter = findChapter(raw, input.chapterId ?? input.id)
      if (chapter === undefined) throw new Error(`unknown chapter "${asString(input.chapterId ?? input.id)}"`)
      const stage = asString(input.stage)
      const check = canSetStage(chapter, stage)
      if (!check.allowed) {
        const names = (check.gate?.blocked ?? [])
          .map((point) => `${point.name}(${Math.round(point.mastery * 100)}%)`)
          .join('、')
        throw new Error(`闸门未通过，不能进入「${STAGE_LABEL[stage] ?? stage}」${names ? `：未达标 ${names}` : ''}`)
      }
      chapter.stage = stage
      chapter.status = stageToStatus(stage)
      chapter.completedAt = stage === 'completed' ? chapter.completedAt ?? nowIso() : null
      chapter.updatedAt = nowIso()
      await touch()
      return { projectId: id, chapter: chapterView(chapter) }
    }

    case 'kp_upsert': {
      const chapter = findChapter(raw, input.chapterId ?? input.chapter?.chapterId)
      if (chapter === undefined) throw new Error(`unknown chapter "${asString(input.chapterId)}"`)
      const source = input.kp && typeof input.kp === 'object' ? input.kp : input
      const kpId = asString(source.id ?? input.id)
      let point = kpId ? (chapter.knowledgePoints ?? []).find((candidate) => candidate.id === kpId) : undefined
      const isNew = point === undefined
      if (isNew) {
        point = {
          id: newId('kp'),
          name: '未命名知识点',
          type: 'memory',
          prerequisiteIds: [],
          sourceIds: [],
          mastery: 0,
          qualitative: false,
          deferred: false,
          override: null,
          attempts: [],
          updatedAt: nowIso(),
        }
        chapter.knowledgePoints = [...(chapter.knowledgePoints ?? []), point]
      }
      if (source.name !== undefined) point.name = asString(source.name)
      if (source.type !== undefined) point.type = oneOf(source.type, KNOWLEDGE_TYPES, point.type)
      if (source.prerequisiteIds !== undefined) {
        point.prerequisiteIds = (Array.isArray(source.prerequisiteIds) ? source.prerequisiteIds : []).map((value) =>
          asString(value),
        )
      }
      if (source.sourceIds !== undefined) {
        point.sourceIds = (Array.isArray(source.sourceIds) ? source.sourceIds : []).map((value) => asString(value))
      }
      if (source.deferred !== undefined) point.deferred = source.deferred === true
      point.updatedAt = nowIso()
      chapter.updatedAt = nowIso()
      if (!raw.states[point.id]) {
        raw.states[point.id] = initialRepetitionState(point.type, nowMs, raw.desiredRetention)
        await saveReviews(dir, raw)
      }
      chapter.progress = chapterProgress(chapter)
      await touch()
      return { projectId: id, knowledgePoint: point, chapter: chapterView(chapter), created: isNew }
    }

    case 'kp_remove': {
      const found = findPoint(raw, input.id)
      if (found === undefined) throw new Error(`unknown knowledge point "${asString(input.id)}"`)
      found.chapter.knowledgePoints = found.chapter.knowledgePoints.filter((point) => point.id !== found.point.id)
      delete raw.states[found.point.id]
      raw.errors = raw.errors.filter((error) => error.knowledgePointId !== found.point.id)
      found.chapter.progress = chapterProgress(found.chapter)
      await saveReviews(dir, raw)
      await savePractice(dir, raw)
      await touch()
      return { projectId: id, removed: found.point.id, chapter: chapterView(found.chapter) }
    }

    case 'kp_defer': {
      const found = findPoint(raw, input.id)
      if (found === undefined) throw new Error(`unknown knowledge point "${asString(input.id)}"`)
      found.point.deferred = input.deferred !== false
      found.point.deferredNote = asString(input.note)
      found.point.updatedAt = nowIso()
      found.chapter.progress = chapterProgress(found.chapter)
      await touch()
      return { projectId: id, knowledgePoint: found.point, gate: chapterGate(found.chapter) }
    }

    case 'kp_override': {
      const found = findPoint(raw, input.id)
      if (found === undefined) throw new Error(`unknown knowledge point "${asString(input.id)}"`)
      found.point.override = input.revoke === true ? null : { note: asString(input.note), at: nowIso(), source: 'learner' }
      found.point.updatedAt = nowIso()
      found.chapter.progress = chapterProgress(found.chapter)
      await touch()
      return { projectId: id, knowledgePoint: found.point, gate: chapterGate(found.chapter) }
    }

    case 'quiz': {
      const found = findPoint(raw, input.knowledgePointId ?? input.kpId ?? input.id)
      if (found === undefined) throw new Error('quiz requires a valid knowledgePointId')
      const prompt = asString(input.prompt ?? input.title)
      if (!prompt.trim()) throw new Error('quiz requires a prompt')
      const expected = asString(input.expectedAnswer ?? input.answer)
      if (!expected.trim()) {
        throw new Error('quiz requires expectedAnswer: it is stored here so grading is deterministic and the model never has to recall it')
      }
      const question = {
        id: newId('q'),
        chapterId: found.chapter.id,
        knowledgePointId: found.point.id,
        prompt,
        type: oneOf(input.questionType ?? input.type, ['short', 'choice', 'numeric', 'boolean'], 'short'),
        matchMode: oneOf(input.matchMode, ['auto', 'exact', 'numeric', 'contains'], 'auto'),
        expectedAnswer: expected,
        acceptedAnswers: (Array.isArray(input.acceptedAnswers) ? input.acceptedAnswers : []).map((value) => asString(value)),
        options: Array.isArray(input.options)
          ? input.options.map((option, index) =>
              typeof option === 'string'
                ? { label: String.fromCharCode(65 + index), body: option }
                : { label: asString(option.label), body: asString(option.body) },
            )
          : [],
        explanation: asString(input.explanation),
        difficulty: asString(input.difficulty),
        createdAt: nowIso(),
        status: 'awaiting_input',
        result: null,
      }
      raw.pending = question
      await savePractice(dir, raw)
      return { projectId: id, question: publicQuestion(question), knowledgePointName: found.point.name }
    }

    case 'quiz_answer': {
      const question = raw.pending
      if (question === null || question === undefined) throw new Error('no pending question; call quiz first')
      if (question.status === 'graded') throw new Error('the pending question was already graded')
      const answer = asString(input.answer)
      const graded = gradeAnswer(question, answer)
      question.status = 'graded'
      question.result = {
        isCorrect: graded.isCorrect,
        matchedBy: graded.matchedBy,
        yourAnswer: answer,
        expectedAnswer: question.expectedAnswer,
        explanation: question.explanation,
        at: nowIso(),
      }

      raw.attempts.push({
        id: newId('a'),
        questionId: question.id,
        knowledgePointId: question.knowledgePointId,
        chapterId: question.chapterId,
        prompt: question.prompt,
        questionType: question.type,
        expectedAnswer: question.expectedAnswer,
        explanation: question.explanation,
        userAnswer: answer,
        isCorrect: graded.isCorrect,
        matchedBy: graded.matchedBy,
        hintsUsed: Math.max(0, Number(input.hintsUsed) || 0),
        selfAttribution: asString(input.selfAttribution),
        createdAt: question.createdAt,
        gradedAt: nowIso(),
      })
      if (raw.attempts.length > 3000) raw.attempts = raw.attempts.slice(-3000)

      const outcome = await recordOutcome(dir, raw, {
        knowledgePointId: question.knowledgePointId,
        result: graded.isCorrect ? 'correct' : 'incorrect',
        source: 'mastery_path',
        assessmentType: 'quiz',
        hintsUsed: input.hintsUsed,
        attemptCount: 1,
        questionId: question.id,
        errorType: input.errorType,
        selfAttribution: input.selfAttribution,
      })
      await savePractice(dir, raw)

      return {
        projectId: id,
        isCorrect: graded.isCorrect,
        matchedBy: graded.matchedBy,
        yourAnswer: answer,
        expectedAnswer: question.expectedAnswer,
        explanation: question.explanation,
        ...outcome,
      }
    }

    case 'quiz_skip': {
      if (raw.pending === null || raw.pending === undefined) throw new Error('no pending question')
      const skipped = raw.pending
      raw.pending = null
      await savePractice(dir, raw)
      return { projectId: id, skipped: { id: skipped.id, prompt: skipped.prompt } }
    }

    /** Qualitative gate for CONCEPT / DESIGN points: the tutor judges. */
    case 'assess': {
      const found = findPoint(raw, input.id ?? input.knowledgePointId)
      if (found === undefined) throw new Error(`unknown knowledge point "${asString(input.id)}"`)
      if (!isQualitative(found.point.type)) {
        throw new Error(
          `knowledge point "${found.point.name}" is ${found.point.type}; only ${QUALITATIVE_TYPES.join('/')} use the qualitative gate`,
        )
      }
      const sufficient = input.sufficient === true
      found.point.qualitative = sufficient
      found.point.assessmentNote = asString(input.note)
      found.point.updatedAt = nowIso()
      return {
        projectId: id,
        sufficient,
        ...(await recordOutcome(dir, raw, {
          knowledgePointId: found.point.id,
          result: sufficient ? 'correct' : 'incorrect',
          source: 'mastery_path',
          assessmentType: 'qualitative',
          quality: sufficient ? Number(input.quality ?? 0.9) : 0.3,
          attemptCount: 1,
        })),
      }
    }

    case 'review_grade': {
      const found = findPoint(raw, input.id ?? input.knowledgePointId)
      if (found === undefined) throw new Error(`unknown knowledge point "${asString(input.id)}"`)
      const grade = oneOf(input.grade, ['again', 'hard', 'good', 'easy'], 'good')
      const quality = grade === 'again' ? 0 : grade === 'hard' ? 0.4 : grade === 'good' ? 0.8 : 1
      const outcome = await recordOutcome(dir, raw, {
        knowledgePointId: found.point.id,
        result: grade === 'again' ? 'incorrect' : grade === 'hard' ? 'partial' : 'correct',
        source: 'mastery_path',
        assessmentType: 'review',
        quality,
        attemptCount: 1,
      })
      if (Number(input.minutes) > 0) {
        await appendLog(dir, raw, {
          kind: 'review',
          chapterId: found.chapter.id,
          knowledgePointId: found.point.id,
          minutes: input.minutes,
          note: `复习：${found.point.name}（${grade}）`,
        })
      }
      return { projectId: id, grade, ...outcome }
    }

    case 'review_due': {
      const queue = reviewQueue(raw, nowMs)
      const labels = pointLabels(raw.chapters)
      const horizonMs = nowMs + Math.max(0, Math.round(Number(input.horizonDays) || 7)) * DAY_MS
      const decorate = (task) => ({ ...task, ...(labels[task.knowledgePointId] ?? {}) })
      return {
        projectId: id,
        today: today(),
        desiredRetention: raw.desiredRetention,
        due: queue.filter((task) => toMs(task.dueAt) <= nowMs).map(decorate),
        upcoming: queue
          .filter((task) => toMs(task.dueAt) > nowMs && toMs(task.dueAt) <= horizonMs)
          .map(decorate),
      }
    }

    /** What to study right now: due reviews, weakest points, errors, blocked modules. */
    case 'practice_due': {
      const queue = reviewQueue(raw, nowMs)
      const flat = flattenPoints(raw.chapters)
      const labels = pointLabels(raw.chapters)
      const done = new Set(
        flat
          .filter(({ point, chapter }) => pointSatisfied(point, chapter.passThreshold ?? 0.7))
          .map(({ point }) => point.id),
      )
      return {
        projectId: id,
        today: today(),
        pending: publicQuestion(raw.pending),
        due: queue
          .filter((task) => toMs(task.dueAt) <= nowMs)
          .map((task) => ({ ...task, ...(labels[task.knowledgePointId] ?? {}) })),
        weakest: flat
          .filter(({ point }) => !point.deferred && point.override === null && !done.has(point.id) && !isQualitative(point.type))
          .sort((a, b) => a.point.mastery - b.point.mastery)
          .slice(0, 8)
          .map(({ point, chapter }) => ({
            knowledgePointId: point.id,
            name: point.name,
            type: point.type,
            mastery: point.mastery,
            chapterId: chapter.id,
            chapterTitle: chapter.title,
          })),
        errors: raw.errors
          .filter((error) => error.status === 'active' || error.status === 'retrying')
          .slice(0, 10)
          .map((error) => ({ ...error, ...(labels[error.knowledgePointId] ?? {}) })),
        gateBlocked: raw.chapters
          .filter((chapter) => chapter.knowledgePoints.length > 0 && !chapterGate(chapter).passed)
          .map((chapter) => ({
            chapterId: chapter.id,
            title: chapter.title,
            stage: chapter.stage,
            blocked: chapterGate(chapter).blocked.map((point) => ({ ...point, ...(labels[point.id] ?? {}) })),
          })),
      }
    }

    case 'material_add': {
      const title = asString(input.title) || '未命名资料'
      const markdown = asString(input.markdown)
      if (!markdown.trim()) throw new Error('material_add requires non-empty markdown')
      const materialId = newId('m')
      const file = `${MATERIALS_DIR}/${materialId}-${slugify(title, 'material')}.md`
      const full = insideDir(dir, file)
      if (full === undefined) throw new Error('resolved material path escapes the project directory')
      await writeText(full, `# ${title}\n\n${markdown.trim()}\n`)
      const chapterIds = Array.isArray(input.chapterIds)
        ? input.chapterIds.map((value) => asString(value)).filter((value) => raw.chapters.some((chapter) => chapter.id === value))
        : []
      const item = {
        id: materialId,
        title,
        file,
        source: asString(input.source) || 'agent',
        kind: asString(input.kind) || 'markdown',
        chapterIds,
        summary: asString(input.summary),
        chars: markdown.length,
        createdAt: nowIso(),
        reading: { locator: 1, percent: 0, furthestLocator: 1, furthestPercent: 0, updatedAt: null },
        notes: [],
      }
      raw.materials.push(item)
      for (const chapter of raw.chapters) {
        if (!chapterIds.includes(chapter.id)) continue
        chapter.materialIds = [...new Set([...(chapter.materialIds ?? []), materialId])]
        chapter.updatedAt = nowIso()
      }
      await saveMaterials(dir, raw)
      await touch()
      await appendLog(dir, raw, { kind: 'material', chapterId: chapterIds[0] ?? null, note: `导入资料：${title}` })
      return { projectId: id, material: item }
    }

    case 'material_read': {
      const item = raw.materials.find((candidate) => candidate.id === asString(input.id))
      if (item === undefined) throw new Error(`unknown material "${asString(input.id)}"`)
      const full = insideDir(dir, item.file)
      if (full === undefined) throw new Error('material path escapes the project directory')
      return {
        projectId: id,
        id: item.id,
        title: item.title,
        file: item.file,
        text: await readTextOr(full),
        reading: item.reading ?? null,
        notes: Array.isArray(item.notes) ? item.notes : [],
      }
    }

    case 'material_remove': {
      const materialId = asString(input.id)
      const item = raw.materials.find((candidate) => candidate.id === materialId)
      if (item === undefined) throw new Error(`unknown material "${materialId}"`)
      raw.materials = raw.materials.filter((candidate) => candidate.id !== materialId)
      for (const chapter of raw.chapters) {
        if (Array.isArray(chapter.materialIds) && chapter.materialIds.includes(materialId)) {
          chapter.materialIds = chapter.materialIds.filter((value) => value !== materialId)
        }
      }
      await saveMaterials(dir, raw)
      await touch()
      return { projectId: id, removed: materialId, file: item.file }
    }

    /* ---------------------------------------------------- material import */

    /** Import text files that already live inside the project folder. */
    case 'project_import_files': {
      const rels = (Array.isArray(input.rels) ? input.rels : [input.rel])
        .map((value) => asString(value))
        .filter((value) => value !== '')
      if (rels.length === 0) throw new Error('project_import_files requires rels（项目文件夹内的相对路径）')
      const imported = []
      const skipped = []
      for (const rel of rels) {
        const full = insideDir(dir, rel)
        if (full === undefined || !existsSync(full)) {
          skipped.push({ rel, reason: 'not-found' })
          continue
        }
        const kind = classifyFile(basename(full))
        if (kind !== 'text') {
          skipped.push({ rel, reason: kind === 'binary' ? 'needs-agent-parsing' : 'unsupported' })
          continue
        }
        const text = await readTextOr(full)
        if (!text.trim()) {
          skipped.push({ rel, reason: 'empty' })
          continue
        }
        const title = asString(input.title) || basename(full).replace(/\.[^.]+$/, '')
        const added = await applyProjectAction(
          host,
          root,
          id,
          { action: 'material_add', title, markdown: text, source: rel, kind: 'file', chapterIds: input.chapterIds },
          dir,
        )
        imported.push({ rel, materialId: added.material.id, title: added.material.title, chars: added.material.chars })
      }
      return { projectId: id, imported, skipped }
    }

    /** Fetch one URL through the Host web service and store it as material. */
    case 'material_fetch': {
      const url = asString(input.url).trim()
      if (!url) throw new Error('material_fetch requires a url')
      if (host === undefined || typeof host.fetchUrl !== 'function') {
        throw new Error('网络抓取不可用：当前 profile 没有 ctx.web 抓取提供者')
      }
      const result = await host.fetchUrl(url, undefined)
      const converted = fetchedToMarkdown(url, result)
      if (!converted.markdown.trim()) {
        throw new Error(`抓取成功但正文为空（HTTP ${result?.statusCode ?? '?'}）：${url}`)
      }
      const title = asString(input.title) || converted.title || url
      const added = await applyProjectAction(
        host,
        root,
        id,
        {
          action: 'material_add',
          title,
          markdown: converted.markdown,
          source: url,
          kind: 'web',
          chapterIds: input.chapterIds,
          summary: input.summary,
        },
        dir,
      )
      return {
        projectId: id,
        url,
        statusCode: result?.statusCode ?? null,
        truncated: result?.truncated === true,
        chars: converted.markdown.length,
        material: added.material,
      }
    }

    case 'reading_progress': {
      const item = raw.materials.find((candidate) => candidate.id === asString(input.materialId ?? input.id))
      if (item === undefined) throw new Error(`unknown material "${asString(input.materialId ?? input.id)}"`)
      const locator = Math.max(1, Math.round(Number(input.locator) || 1))
      const percent = clamp(input.percent ?? 0, 0, 1)
      const previous = item.reading ?? { locator: 1, percent: 0, furthestLocator: 1, furthestPercent: 0, updatedAt: null }
      item.reading = {
        locator,
        percent,
        furthestLocator: Math.max(Number(previous.furthestLocator) || 1, locator),
        furthestPercent: Math.max(Number(previous.furthestPercent) || 0, percent),
        updatedAt: nowIso(),
      }
      await saveMaterials(dir, raw)
      if (Number(input.minutes) > 0) {
        await appendLog(dir, raw, {
          kind: 'reading',
          chapterId: item.chapterIds?.[0] ?? null,
          minutes: input.minutes,
          note: `阅读：${item.title}`,
        })
      }
      return { projectId: id, materialId: item.id, reading: item.reading }
    }

    case 'note_add': {
      const item = raw.materials.find((candidate) => candidate.id === asString(input.materialId ?? input.id))
      if (item === undefined) throw new Error(`unknown material "${asString(input.materialId ?? input.id)}"`)
      const text = asString(input.text ?? input.markdown).slice(0, MAX_NOTE_CHARS)
      if (!text.trim()) throw new Error('note_add requires text')
      const note = {
        id: newId('n'),
        anchor: asString(input.anchor),
        locator: Math.max(1, Math.round(Number(input.locator) || 1)),
        percent: clamp(input.percent ?? 0, 0, 1),
        text,
        knowledgePointIds: (Array.isArray(input.knowledgePointIds) ? input.knowledgePointIds : []).map((value) =>
          asString(value),
        ),
        createdAt: nowIso(),
      }
      item.notes = [...(item.notes ?? []), note]
      await saveMaterials(dir, raw)
      return { projectId: id, materialId: item.id, note, notes: item.notes.length }
    }

    case 'note_remove': {
      const item = raw.materials.find((candidate) => candidate.id === asString(input.materialId))
      if (item === undefined) throw new Error(`unknown material "${asString(input.materialId)}"`)
      const noteId = asString(input.id)
      const before = (item.notes ?? []).length
      item.notes = (item.notes ?? []).filter((note) => note.id !== noteId)
      if (item.notes.length === before) throw new Error(`unknown note "${noteId}"`)
      await saveMaterials(dir, raw)
      return { projectId: id, removed: noteId, notes: item.notes.length }
    }

    case 'task_add': {
      const source = input.task && typeof input.task === 'object' ? input.task : input
      const title = asString(source.title ?? input.title)
      if (!title.trim()) throw new Error('task_add requires a title')
      const chapterId = asString(source.chapterId ?? input.chapterId)
      const task = {
        id: newId('t'),
        title,
        chapterId: raw.chapters.some((chapter) => chapter.id === chapterId) ? chapterId : null,
        knowledgePointId: findPoint(raw, source.knowledgePointId)?.point.id ?? null,
        status: oneOf(source.status, ['todo', 'doing', 'done'], 'todo'),
        priority: oneOf(source.priority, ['low', 'normal', 'high'], 'normal'),
        due: asString(source.due) || null,
        estimateMin: Math.max(0, Math.round(Number(source.estimateMin ?? input.estimateMin) || 0)),
        spentMin: 0,
        note: asString(source.note),
        createdAt: nowIso(),
        updatedAt: nowIso(),
        completedAt: null,
      }
      raw.tasks.push(task)
      await saveTasks(dir, raw)
      await touch()
      return { projectId: id, task }
    }

    case 'task_update': {
      const taskId = asString(input.id)
      const task = raw.tasks.find((candidate) => candidate.id === taskId)
      if (task === undefined) throw new Error(`unknown task "${taskId}"`)
      const patch = input.patch && typeof input.patch === 'object' ? input.patch : input
      if (patch.title !== undefined) task.title = asString(patch.title)
      if (patch.chapterId !== undefined) {
        const chapterId = asString(patch.chapterId)
        task.chapterId = raw.chapters.some((chapter) => chapter.id === chapterId) ? chapterId : null
      }
      if (patch.status !== undefined) task.status = oneOf(patch.status, ['todo', 'doing', 'done'], task.status)
      if (patch.priority !== undefined) task.priority = oneOf(patch.priority, ['low', 'normal', 'high'], task.priority)
      if (patch.due !== undefined) task.due = asString(patch.due) || null
      if (patch.note !== undefined) task.note = asString(patch.note)
      if (patch.estimateMin !== undefined) task.estimateMin = Math.max(0, Math.round(Number(patch.estimateMin) || 0))
      if (patch.spentMin !== undefined) task.spentMin = Math.max(0, Math.round(Number(patch.spentMin) || 0))
      task.completedAt = task.status === 'done' ? task.completedAt ?? nowIso() : null
      task.updatedAt = nowIso()
      await saveTasks(dir, raw)
      await touch()
      return { projectId: id, task }
    }

    case 'task_remove': {
      const taskId = asString(input.id)
      const before = raw.tasks.length
      raw.tasks = raw.tasks.filter((task) => task.id !== taskId)
      if (raw.tasks.length === before) throw new Error(`unknown task "${taskId}"`)
      await saveTasks(dir, raw)
      await touch()
      return { projectId: id, removed: taskId, tasks: raw.tasks.length }
    }

    case 'progress_log': {
      const entry = await appendLog(dir, raw, {
        kind: asString(input.kind) || 'study',
        chapterId: asString(input.chapterId) || null,
        taskId: asString(input.taskId) || null,
        knowledgePointId: asString(input.knowledgePointId) || null,
        minutes: input.minutes,
        note: input.note,
      })
      const task = entry.taskId ? raw.tasks.find((candidate) => candidate.id === entry.taskId) : undefined
      if (task !== undefined && entry.minutes > 0) {
        task.spentMin = (Number(task.spentMin) || 0) + entry.minutes
        task.updatedAt = nowIso()
        await saveTasks(dir, raw)
      }
      await touch()
      return { projectId: id, entry, stats: computeStats(raw) }
    }

    default:
      throw new Error(`action "${action}" is a project-level action; call it without a project context`)
  }
}

/* ---------------------------------------------------------------- init */

async function initProjectAt(dir, id, input) {
  await mkdir(join(dir, MATERIALS_DIR), { recursive: true })
  const raw = await loadRaw(dir)
  const force = input.force === true
  const created = !raw.exists

  if (created || force) {
    raw.project = {
      ...raw.project,
      id,
      title: asString(input.title || raw.project.title) || '未命名学习项目',
      goal: asString(input.goal ?? raw.project.goal),
      subject: asString(input.subject ?? raw.project.subject),
      createdAt: created ? nowIso() : raw.project.createdAt,
      updatedAt: nowIso(),
    }
    await saveProject(dir, raw)
  }
  if (force || !existsSync(join(dir, PROJECT_FILES.materials))) await saveMaterials(dir, raw)
  if (force || !existsSync(join(dir, PROJECT_FILES.tasks))) await saveTasks(dir, raw)
  if (force || !existsSync(join(dir, PROJECT_FILES.progress))) await saveProgress(dir, raw)
  if (force || !existsSync(join(dir, PROJECT_FILES.reviews))) await saveReviews(dir, raw)
  if (force || !existsSync(join(dir, PROJECT_FILES.practice))) await savePractice(dir, raw)

  const written = []
  for (const [file, text] of [
    [DOC_FILES.plan, planTemplate(raw.project)],
    [DOC_FILES.outline, outlineTemplate()],
    [DOC_FILES.exercises, exercisesTemplate()],
  ]) {
    const full = join(dir, file)
    if (force || !existsSync(full)) {
      await writeText(full, text)
      written.push(file)
    }
  }
  return { id, dir, created, wrote: written, project: raw.project }
}

/* ------------------------------------------------------------ registry */

async function freeId(root, title, keep) {
  const base = slugify(title, 'project')
  let candidate = base
  let n = 2
  while (candidate !== keep && existsSync(join(root.dir, candidate))) candidate = `${base}-${n++}`
  return candidate
}

export const PROJECT_ACTIONS = [
  'status',
  'help',
  'project_list',
  'project_scan',
  'project_create',
  'project_get',
  'project_rename',
  'project_remove',
  'project_use',
  'project_migrate',
]

export const ACTIONS = [
  ...PROJECT_ACTIONS,
  'state',
  'init',
  'learner_set',
  'plan_write',
  'outline_write',
  'exercise_write',
  'chapter_upsert',
  'chapter_remove',
  'stage_set',
  'kp_upsert',
  'kp_remove',
  'kp_defer',
  'kp_override',
  'quiz',
  'quiz_answer',
  'quiz_skip',
  'assess',
  'review_grade',
  'review_due',
  'practice_due',
  'material_add',
  'material_read',
  'material_remove',
  'material_fetch',
  'project_import_files',
  'reading_progress',
  'note_add',
  'note_remove',
  'task_add',
  'task_update',
  'task_remove',
  'progress_log',
]

const HELP = `learning 工具的动作。核心原则：模型决定教什么和怎么问，**能否进阶由确定性闸门决定**。

项目管理（不需要 projectId）
  help · status · project_list
  project_scan { dir, maxDepth?, maxFiles? }
      只读识别一个文件夹：是否已经是标准 DashinLearning 项目（同时存在 learning.md 与 learning.json），
      以及里面有哪些可导入的资料文件。
  project_create { title?, dir?, goal?, subject?, createDir? }
      省略 dir → 在容器下新建 <title>/；给了 dir → 关联该文件夹（不存在则创建），
      已是标准项目就接管、否则就地初始化骨架（绝不覆盖已有文件）。
      创建后会把这个文件夹注册成 DSH 工作区，出现在左侧工作区树里。
  project_get { projectId } · project_use { projectId }
  project_rename { projectId, title, renameDir? }   默认只改显示名，不动用户的文件夹
  project_remove { projectId, purge?, confirm? }    默认只从列表移除；purge+confirm 才真删文件夹
  project_migrate

学习者画像 intake
  learner_set { learner: { priorKnowledge, targetLevel, timeBudget, preferences,
                           teachingStrategy: probe_first|teach_first, notes }, desiredRetention? }

章节与知识点
  chapter_upsert { chapter: { id?, title, order?, objective?, passThreshold?, status? } }
  chapter_remove { id }
  stage_set { chapterId, stage }        stage: ${STAGES.join(' | ')}
  kp_upsert { chapterId, kp: { id?, name, type, prerequisiteIds?, sourceIds? } }
                                        type: ${KNOWLEDGE_TYPES.join(' | ')}（concept/design 走定性闸门）
  kp_remove { id } · kp_defer { id, deferred?, note? } · kp_override { id, note?, revoke? }

出题与练题（答案存在 Host，评分确定性，模型不需要记住答案）
  quiz { knowledgePointId, prompt, expectedAnswer, questionType?, matchMode?, acceptedAnswers?, options?, explanation? }
  quiz_answer { answer, hintsUsed?, selfAttribution?, errorType? }    errorType: ${ERROR_TYPES.join(' | ')}
  quiz_skip
  assess { id, sufficient, note? }      仅 concept/design：定性判定（复述检验）

复习
  review_due { horizonDays? }
  practice_due                          今天该练什么：到期复习 + 最弱知识点 + 未解决错题 + 被闸门拦住的章节
  review_grade { id, grade: again|hard|good|easy, minutes? }

资料与阅读
  material_add { title, markdown, source?, kind?, chapterIds?, summary? }
  material_fetch { url, title?, chapterIds?, summary? }   从网络抓取一个 URL，HTML 转 markdown 后落盘
  project_import_files { rels: [...] }                    把关联文件夹里已有的文本文件导入成资料
  material_read { id } · material_remove { id }
  reading_progress { materialId, locator, percent, minutes? }
  note_add { materialId, text, locator?, percent?, anchor?, knowledgePointIds? } · note_remove { materialId, id }

任务与流水
  task_add { task: { title, chapterId?, knowledgePointId?, priority?, due?, estimateMin?, note? } }
  task_update { id, patch } · task_remove { id }
  progress_log { minutes, chapterId?, knowledgePointId?, taskId?, kind?, note? }

文档
  plan_write · outline_write · exercise_write { markdown, mode?: replace|append }
  state · init`

/* ------------------------------------------------------------- dispatch */

/* --------------------------------------------------------------- helpers */

function uniqueId(projects, base) {
  let candidate = base
  let n = 2
  while (projects.some((project) => project.id === candidate)) candidate = `${base}-${n++}`
  return candidate
}

async function freeDirName(parent, base) {
  let candidate = base
  let n = 2
  while (existsSync(join(parent, candidate))) candidate = `${base}-${n++}`
  return candidate
}

/** Best-effort: a learning project should also show up as a DSH workspace. */
async function registerWorkspaceFor(host, dir, title) {
  if (host === undefined || typeof host.registerWorkspace !== 'function') return null
  try {
    const workspace = await host.registerWorkspace(dir, title)
    return workspace ?? null
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * @param host - the Host services this module cannot reach itself:
 *   `registerWorkspace(dir, title)` and `fetchUrl(url, signal)`.
 * @param root - the resolved container: `{ dir, source }`.
 * @param input - the action payload.
 */
export async function runAction(host, root, input) {
  const action = asString(input?.action)
  if (!ACTIONS.includes(action)) throw new Error(`unknown action "${action}". ${HELP}`)
  if (action === 'help') {
    return {
      actions: ACTIONS,
      stages: STAGES,
      knowledgeTypes: KNOWLEDGE_TYPES,
      errorTypes: ERROR_TYPES,
      intervalSequences: INTERVAL_SEQUENCES,
      help: HELP,
    }
  }
  if (action === 'project_list') return viewProjects(root)

  /* ------------------------------------------- folder inspection (read-only) */

  if (action === 'project_scan') {
    const given = asString(input.dir).trim()
    const dir = given === '' ? root.dir : resolve(given)
    const scan = await scanFolder(dir, { maxDepth: input.maxDepth, maxFiles: input.maxFiles })
    const known = (await loadRegistry(root)).find((project) => project.dir === dir)
    return {
      ...scan,
      knownProjectId: known?.id ?? null,
      note:
        scan.exists === false
          ? '文件夹不存在，可以是新建的目标位置'
          : scan.isStandard
            ? '已经是标准 DashinLearning 项目（learning.md + learning.json 都在）'
            : scan.empty
              ? '空文件夹，会初始化为新的学习项目'
              : '普通文件夹，会就地初始化，已有文件不会被改动，可以按需导入为资料',
    }
  }

  /* ------------------------------------------------------------ creation */

  if (action === 'project_create') {
    const projects = await loadRegistry(root)
    const givenDir = asString(input.dir).trim()
    let title = asString(input.title).trim()
    let dir
    let createdFolder = false

    if (givenDir !== '') {
      dir = resolve(givenDir)
      if (!existsSync(dir)) {
        if (input.createDir === false) throw new Error(`文件夹不存在：${dir}`)
        await mkdir(join(dir, MATERIALS_DIR), { recursive: true })
        createdFolder = true
      }
    } else {
      if (!title) throw new Error('project_create 需要 title（在容器下新建）或 dir（关联已有文件夹）')
      dir = join(root.dir, await freeId(root, title))
      await mkdir(join(dir, MATERIALS_DIR), { recursive: true })
      createdFolder = true
    }

    if (!title) title = basename(dir)
    const standard = isStandardProject(dir)
    const id = uniqueId(projects, slugify(basename(dir), 'project'))

    if (!standard) {
      // A plain folder becomes a project in place. Existing files are never
      // touched — the scan result tells the caller what could be imported.
      await initProjectAt(dir, id, { title, goal: input.goal, subject: input.subject })
    } else if (input.title !== undefined) {
      const raw = await loadRaw(dir)
      raw.project = { ...raw.project, id, title, updatedAt: nowIso() }
      await saveProject(dir, raw)
    }

    const workspace = await registerWorkspaceFor(host, dir, title)
    await writeRegistry(root, [
      ...projects,
      {
        id,
        dir,
        title,
        addedAt: nowIso(),
        standard,
        managed: createdFolder,
        workspaceId: workspace?.id ?? null,
      },
    ])
    if ((await readCurrent(root)) === null) await writeCurrent(root, id)

    const scan = await scanFolder(dir)
    return {
      project: { id, dir, title, standard, managed: createdFolder, workspace },
      created: createdFolder,
      adopted: standard,
      scan,
      next: standard
        ? '已接管这个文件夹，可以直接开始学习。'
        : '已就地初始化。可以把 scan.files 里的文本文件用 project_import_files 导入成资料，再让 Agent 依据资料生成大纲与知识点。',
    }
  }

  /* ---------------------------------------------------------- read / use */

  if (action === 'project_get') {
    const id = asString(input.projectId).trim()
    return viewProject(root, id === '' ? (await readCurrent(root)) ?? '' : id)
  }

  if (action === 'project_use') {
    const id = asString(input.projectId).trim()
    const entry = await lookupProject(root, id)
    if (entry === undefined) throw new Error(`unknown learning project "${id}"`)
    await writeCurrent(root, id)
    const workspace = await registerWorkspaceFor(host, entry.dir, entry.title ?? id)
    if (workspace !== null && workspace.id !== undefined) {
      const projects = await loadRegistry(root)
      await writeRegistry(
        root,
        projects.map((project) => (project.id === id ? { ...project, workspaceId: workspace.id } : project)),
      )
    }
    return { current: id, dir: entry.dir, workspace }
  }

  /* ------------------------------------------------------------- rename */

  if (action === 'project_rename') {
    const id = asString(input.projectId).trim()
    const entry = await lookupProject(root, id)
    if (entry === undefined) throw new Error(`unknown learning project "${id}"`)
    const title = asString(input.title).trim()
    if (!title) throw new Error('project_rename requires a title')
    let dir = entry.dir
    if (input.renameDir === true) {
      const parent = dirname(dir)
      const nextDir = join(parent, await freeDirName(parent, slugify(title, 'project')))
      if (nextDir !== dir) {
        await rename(dir, nextDir)
        dir = nextDir
      }
    }
    const raw = await loadRaw(dir)
    raw.project = { ...raw.project, id, title, updatedAt: nowIso() }
    await saveProject(dir, raw)
    const projects = await loadRegistry(root)
    await writeRegistry(
      root,
      projects.map((project) => (project.id === id ? { ...project, title, dir } : project)),
    )
    return { projectId: id, dir, title, renamedFolder: dir !== entry.dir }
  }

  /* ------------------------------------------------------------- remove */

  if (action === 'project_remove') {
    const id = asString(input.projectId).trim()
    const entry = await lookupProject(root, id)
    if (entry === undefined) throw new Error(`unknown learning project "${id}"`)
    let purged = false
    if (input.purge === true) {
      if (input.confirm !== true) {
        throw new Error(`purge 会删除整个文件夹 ${entry.dir} 及其全部内容；确认请同时传 confirm: true`)
      }
      await rm(entry.dir, { recursive: true, force: true })
      purged = true
    }
    const remaining = (await loadRegistry(root)).filter((project) => project.id !== id)
    await writeRegistry(root, remaining)
    if ((await readCurrent(root)) === id) {
      if (remaining.length > 0) await writeCurrent(root, remaining[0].id)
      else await rm(join(root.dir, CURRENT_FILE), { force: true })
    }
    return { removed: id, dir: entry.dir, purged, remaining: remaining.length }
  }

  /* ---------------------------------------------------------- migration */

  if (action === 'project_migrate') {
    if (!LEGACY_MARKERS.some((file) => existsSync(join(root.dir, file)))) {
      throw new Error(`no legacy single-project files found directly under ${root.dir}`)
    }
    const raw = await loadRaw(root.dir)
    const title = asString(input.title) || raw.project.title || '学习项目'
    const projects = await loadRegistry(root)
    const id = uniqueId(projects, slugify(title, 'project'))
    const target = join(root.dir, id)
    await mkdir(target, { recursive: true })
    for (const file of [...Object.values(PROJECT_FILES), ...Object.values(DOC_FILES)]) {
      const from = join(root.dir, file)
      if (existsSync(from)) await rename(from, join(target, file))
    }
    const legacyMaterials = join(root.dir, MATERIALS_DIR)
    if (existsSync(legacyMaterials)) {
      await rm(join(target, MATERIALS_DIR), { recursive: true, force: true })
      await rename(legacyMaterials, join(target, MATERIALS_DIR))
    }
    const moved = await loadRaw(target)
    moved.project = { ...moved.project, title, updatedAt: nowIso() }
    await saveProject(target, moved)
    const workspace = await registerWorkspaceFor(host, target, title)
    await writeRegistry(root, [
      ...projects,
      { id, dir: target, title, addedAt: nowIso(), standard: true, managed: true, workspaceId: workspace?.id ?? null },
    ])
    await writeCurrent(root, id)
    return { projectId: id, dir: target, title }
  }

  /* ------------------------------------------------------------- status */

  if (action === 'status') {
    const overview = await viewProjects(root)
    const explicit = asString(input.projectId).trim()
    const id = explicit || overview.current
    if (id === null || id === '') {
      return { ...overview, note: '还没有任何学习项目。用 project_create 建一个（可带 dir 关联已有文件夹）。' }
    }
    const entry = await lookupProject(root, id)
    if (entry === undefined) throw new Error(`unknown learning project "${id}"`)
    const dir = requireDir(entry)
    const raw = await loadRaw(dir)
    const nowMs = Date.now()
    const queue = reviewQueue(raw, nowMs)
    const flat = flattenPoints(raw.chapters)
    return {
      root: root.dir,
      source: root.source,
      current: id,
      count: overview.count,
      projects: overview.projects.map((project) => ({
        id: project.id,
        title: project.title,
        dir: project.dir,
        missing: project.missing === true,
        stats: project.stats,
      })),
      legacy: overview.legacy,
      version: raw.version,
      dir: entry.dir,
      standard: isStandardProject(dir),
      project: { ...raw.project, id },
      learner: raw.learner,
      learnerAsked: raw.learner?.updatedAt !== null && raw.learner?.updatedAt !== undefined,
      stats: computeStats(raw),
      gateBlocked: raw.chapters
        .filter((chapter) => chapter.knowledgePoints.length > 0 && !chapterGate(chapter).passed)
        .slice(0, 5)
        .map((chapter) => ({
          chapterId: chapter.id,
          title: chapter.title,
          stage: chapter.stage,
          blocked: chapterGate(chapter).blocked.slice(0, 5),
        })),
      weakestPoints: flat
        .filter(
          ({ point, chapter }) =>
            !point.deferred && !isQualitative(point.type) && !pointSatisfied(point, chapter.passThreshold ?? 0.7),
        )
        .sort((a, b) => a.point.mastery - b.point.mastery)
        .slice(0, 8)
        .map(({ point, chapter }) => ({
          id: point.id,
          name: point.name,
          type: point.type,
          mastery: point.mastery,
          chapterTitle: chapter.title,
        })),
      dueReviews: queue.filter((task) => toMs(task.dueAt) <= nowMs).slice(0, 10),
      pending: publicQuestion(raw.pending),
      openTasks: raw.tasks.filter((task) => task.status !== 'done').slice(0, 10),
      activeErrors: raw.errors.filter((error) => error.status === 'active' || error.status === 'retrying').slice(0, 10),
    }
  }

  const explicit = asString(input.projectId).trim()
  const id = explicit || (await readCurrent(root))
  if (id === null || id === '') {
    throw new Error('还没有任何学习项目。用 project_create 建一个（可带 dir 关联已有文件夹）。')
  }
  const entry = await lookupProject(root, id)
  if (entry === undefined) throw new Error(`unknown learning project "${id}"`)
  return applyProjectAction(host, root, id, input, requireDir(entry))
}

/* -------------------------------------------------------------- prompt */

export function promptText(root) {
  return [
    '## DashinLearning 学习项目',
    '',
    `项目注册表：${root.dir}/projects.json（项目是**任意文件夹**，不一定要放在这个目录下）`,
    '学习内容与状态只存在于每个项目文件夹里的这些文件：',
    '- `learning.json` 学习者画像 + 章节 + 知识点 · `reviews.json` 间隔重复状态 · `practice.json` 出题与错题',
    '- `materials.json` + `materials/` 资料索引、正文、阅读进度与笔记',
    '- `learning.md` 计划 · `outline.md` 大纲 · `exercises.md` 练习题 · `tasks.json` 任务 · `progress.json` 流水',
    '',
    '一个文件夹同时存在 `learning.md` 与 `learning.json`，就是一个**标准 DashinLearning 项目**。',
    '**掌握度由测验证据算出，不由谁声明；闸门通过才能进入复习与完成。**',
    '出题用 `quiz`（答案存在 Host，评分确定性，你不需要记住答案）；学习者作答后 `quiz_answer` 返回对错、正解与解析。',
    '开始任何学习相关回答前，先 action=status 或 action=practice_due 读真实进度，不要凭记忆或上下文推断。',
  ].join('\n')
}

export const INTERNALS = {
  PROJECT_FILES,
  DOC_FILES,
  MATERIALS_DIR,
  CURRENT_FILE,
  REGISTRY_FILE,
  MAX_BODY_BYTES,
  STATE_VERSION,
}
