/**
 * @module @local/dashin-learning/host-engine
 *
 * The deterministic half of the learning model, ported from DeepTutor's
 * `deeptutor/learning/` (Apache-2.0, HKUDS).
 *
 * The design axiom it inherits: **the intelligence lives at the loop's exit.**
 * The model decides what to teach and how to question; whether the learner may
 * ADVANCE is a pure function call made here, with no model in the loop. Nothing
 * in this file performs I/O, reads the clock implicitly, or holds state — every
 * function takes its inputs and an explicit `nowMs` and returns a new value, so
 * the same evidence always replays to the same schedule.
 *
 * Two engines, each with one job:
 *
 *   mastery  — `computeMastery(correctness)` maps a knowledge point's attempt
 *              history to 0..1. Recency-weighted accuracy under a confidence
 *              cap, so one lucky answer can never master a point.
 *   schedule — an exponential-forgetting retention model
 *              (`retrievability = exp(-elapsed / stability)`) with per-type
 *              cold-start intervals, instead of the SM-2 style arithmetic the
 *              first version used.
 *
 * Dates cross the boundary as ISO strings because every fact here is stored in
 * a plain JSON file a human may open; epoch milliseconds are the working unit.
 */

export const DAY_MS = 86_400_000

/* ------------------------------------------------------------ vocabulary */

export const KNOWLEDGE_TYPES = ['memory', 'concept', 'procedure', 'design']
export const QUALITATIVE_TYPES = ['concept', 'design']
export const ERROR_TYPES = ['structural', 'deviation', 'application', 'metacognitive']
export const STAGES = ['diagnostic', 'explain', 'feynman_check', 'practice', 'error_diagnosis', 'review', 'completed']
export const ERROR_STATUSES = ['active', 'retrying', 'review', 'graduated']

/** Cold-start review intervals in days, by knowledge type. */
export const INTERVAL_SEQUENCES = {
  memory: [0, 1, 3, 7, 14, 30, 60],
  concept: [3, 7, 14, 30],
  procedure: [3, 7, 14],
  design: [14, 28],
}

/** Queue priority: higher means more urgent. Errors outrank every type. */
export const TYPE_PRIORITY = { memory: 2, concept: 3, procedure: 4, design: 5 }

/** Cold-start difficulty prior, by knowledge type. */
export const TYPE_DIFFICULTY = { memory: 0.3, concept: 0.4, procedure: 0.5, design: 0.6 }

export const DESIRED_RETENTION = { default: 0.9, min: 0.7, max: 0.99 }

const MIN_STABILITY_DAYS = 0.5
const FAIL_QUALITY = 0.5
const EPS = 1e-6
/** Practice this soon after the last review refreshes recall but is not a new retrieval. */
const SAME_SESSION_DAYS = 0.25

const RECENCY_WEIGHTS = [0.5, 0.7, 0.85, 0.95, 1.0]
const CONFIDENCE_CAP = { 1: 0.5, 2: 0.8 }

/* --------------------------------------------------------------- helpers */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

const isType = (type) => KNOWLEDGE_TYPES.includes(type)

export const toMs = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value !== '') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export const toIso = (ms) => new Date(ms).toISOString()

/** Midnight-anchored `YYYY-MM-DD`, the day a task falls due on. */
export const toDay = (ms) => new Date(ms).toISOString().slice(0, 10)

export function validateDesiredRetention(value) {
  const desired = Number(value)
  if (!Number.isFinite(desired)) return DESIRED_RETENTION.default
  return clamp(desired, DESIRED_RETENTION.min, DESIRED_RETENTION.max)
}

/* ---------------------------------------------------------------- mastery */

/**
 * A knowledge point's mastery from its attempt outcomes, oldest first.
 *
 * Recency-weighted accuracy under a confidence cap: the newest attempts weigh
 * most, so recovering from early mistakes is rewarded, but one or two correct
 * answers cannot declare a point mastered.
 */
export function computeMastery(correctness) {
  const history = Array.isArray(correctness) ? correctness : []
  if (history.length === 0) return 0
  const recent = history.slice(-RECENCY_WEIGHTS.length)
  const weights = RECENCY_WEIGHTS.slice(-recent.length)
  let score = 0
  let total = 0
  for (let index = 0; index < recent.length; index += 1) {
    score += weights[index] * (recent[index] ? 1 : 0)
    total += weights[index]
  }
  return Math.min(score / total, CONFIDENCE_CAP[recent.length] ?? 1)
}

/** Whether this type is gated by the tutor's judgement instead of a score. */
export const isQualitative = (type) => QUALITATIVE_TYPES.includes(type)

/**
 * Whether one knowledge point currently clears the module's bar.
 * Deferred points never block, and a learner override always passes.
 */
export function pointSatisfied(point, threshold) {
  if (point === null || point === undefined) return false
  if (point.deferred) return true
  if (point.override && point.override.at) return true
  if (isQualitative(point.type)) return point.qualitative === true
  return Number(point.mastery) >= threshold
}

/**
 * The hard gate: may this module advance? Deterministic and model-free.
 * Returns every blocking point with the reason it blocks, so a caller can
 * explain the refusal instead of just denying it.
 */
export function chapterGate(chapter) {
  const points = Array.isArray(chapter?.knowledgePoints) ? chapter.knowledgePoints : []
  const threshold = Number(chapter?.passThreshold)
  const bar = Number.isFinite(threshold) && threshold > 0 ? threshold : 0.7
  const blocked = []
  for (const point of points) {
    if (pointSatisfied(point, bar)) continue
    blocked.push({
      id: point.id,
      name: point.name,
      type: point.type,
      reason: isQualitative(point.type) ? 'needs-qualitative-check' : 'below-threshold',
      mastery: Number(point.mastery) || 0,
      threshold: bar,
    })
  }
  return { passed: blocked.length === 0, threshold: bar, blocked, total: points.length }
}

/**
 * Module progress derived from evidence — never a number a caller may assert.
 * A point counts in proportion to how far it has come toward the bar, so
 * clearing the threshold reads as 100% rather than as its raw mastery.
 * Deferred points are excluded from both numerator and denominator.
 */
export function chapterProgress(chapter) {
  const points = (Array.isArray(chapter?.knowledgePoints) ? chapter.knowledgePoints : []).filter(
    (point) => !point.deferred,
  )
  if (points.length === 0) return 0
  const threshold = Number(chapter?.passThreshold)
  const bar = Number.isFinite(threshold) && threshold > 0 ? threshold : 0.7
  let sum = 0
  for (const point of points) {
    if (point.override && point.override.at) sum += 1
    else if (isQualitative(point.type)) sum += point.qualitative === true ? 1 : 0
    else sum += clamp((Number(point.mastery) || 0) / bar, 0, 1)
  }
  return Math.round((sum / points.length) * 100)
}

/* --------------------------------------------------------- stage machine */

export const stageIndex = (stage) => {
  const index = STAGES.indexOf(stage)
  return index < 0 ? 0 : index
}

/**
 * Whether a stage transition is allowed. Moving backwards is always allowed —
 * a learner may always go back and re-explain. Moving forward past `practice`
 * requires the gate, and `completed` requires it unconditionally.
 */
export function canSetStage(chapter, stage) {
  if (!STAGES.includes(stage)) return { allowed: false, reason: `unknown stage "${stage}"` }
  const from = stageIndex(chapter?.stage)
  const to = stageIndex(stage)
  if (to <= from) return { allowed: true }
  if (to >= stageIndex('completed')) {
    const gate = chapterGate(chapter)
    return gate.passed ? { allowed: true } : { allowed: false, reason: 'gate', gate }
  }
  if (to >= stageIndex('review')) {
    const gate = chapterGate(chapter)
    return gate.passed ? { allowed: true } : { allowed: false, reason: 'gate', gate }
  }
  return { allowed: true }
}

/* -------------------------------------------------------------- schedule */

function stabilityFromInterval(intervalDays, desiredRetention) {
  const retention = clamp(desiredRetention, EPS, 1 - EPS)
  if (intervalDays <= 0) return MIN_STABILITY_DAYS
  return Math.max(MIN_STABILITY_DAYS, intervalDays / -Math.log(retention))
}

function intervalFromStability(stability, desiredRetention) {
  const retention = clamp(desiredRetention, EPS, 1 - EPS)
  return Math.max(EPS, Math.max(stability, EPS) * -Math.log(retention))
}

function scheduledIntervalDays(state, type) {
  const intervals = INTERVAL_SEQUENCES[type] ?? INTERVAL_SEQUENCES.memory
  if (state.reviewCount === 0 && intervals[0] === 0) return 0
  let intervalDays = intervalFromStability(state.stability, state.desiredRetention)
  if (state.scheduledAfterFailure) {
    intervalDays = Math.min(intervalDays, Math.max(intervalDays * 0.5, MIN_STABILITY_DAYS * 0.2))
  }
  return intervalDays
}

function snapIntervalIndex(intervals, intervalDays) {
  let nearest = 0
  let best = Infinity
  for (let index = 0; index < intervals.length; index += 1) {
    const distance = Math.abs(intervals[index] - intervalDays)
    if (distance < best) {
      best = distance
      nearest = index
    }
  }
  return nearest
}

/**
 * Fill the retention fields of a state written by an older generation, without
 * moving its due time: an already-scheduled review keeps the date it was given.
 */
export function hydrate(state, type) {
  const next = { ...state }
  next.desiredRetention = state.desiredRetention
    ? validateDesiredRetention(state.desiredRetention)
    : DESIRED_RETENTION.default
  if (Number(next.stability) > 0) {
    if (!(Number(next.difficulty) > 0)) next.difficulty = TYPE_DIFFICULTY[type] ?? 0.3
    return next
  }
  const intervals = INTERVAL_SEQUENCES[type] ?? INTERVAL_SEQUENCES.memory
  const maxIndex = intervals.length - 1
  next.intervalIndex = clamp(Number(state.intervalIndex) || 0, 0, maxIndex)
  next.stability = stabilityFromInterval(intervals[next.intervalIndex], next.desiredRetention)
  next.difficulty = TYPE_DIFFICULTY[type] ?? 0.3
  if (!(Number(next.retrievability) > 0)) next.retrievability = 1
  return next
}

/** A brand-new repetition state for one knowledge point. */
export function initialRepetitionState(type, nowMs, desiredRetention) {
  const intervals = INTERVAL_SEQUENCES[type] ?? INTERVAL_SEQUENCES.memory
  const first = Number(intervals[0])
  const desired = desiredRetention === undefined
    ? DESIRED_RETENTION.default
    : validateDesiredRetention(desiredRetention)
  const stability = stabilityFromInterval(first, DESIRED_RETENTION.default)
  const initialInterval = first === 0 ? 0 : intervalFromStability(stability, desired)
  return {
    intervalIndex: 0,
    consecutiveCorrect: 0,
    consecutiveWrong: 0,
    nextReviewAt: toIso(nowMs + initialInterval * DAY_MS),
    difficulty: TYPE_DIFFICULTY[type] ?? 0.3,
    stability,
    retrievability: 1,
    desiredRetention: desired,
    reviewCount: 0,
    lapseCount: 0,
    lastReviewAt: null,
    lastScheduledAt: toIso(nowMs),
    scheduledAfterFailure: false,
  }
}

/** The probability the learner still recalls this point right now. */
export function retrievability(state, nowMs) {
  const stability = Math.max(Number(state.stability) || 0, EPS)
  const anchor = toMs(state.lastReviewAt) ?? toMs(state.nextReviewAt) ?? nowMs
  const elapsedDays = Math.max(0, nowMs - anchor) / DAY_MS
  return clamp(Math.exp(-elapsedDays / stability), 0, 1)
}

/**
 * Review urgency in 0..1: how likely this is to have been forgotten, plus
 * penalties for being overdue, for being an active mistake, and for lapsing.
 */
export function forgettingRisk(state, options = {}) {
  const nowMs = options.nowMs ?? Date.now()
  const risk = 1 - retrievability(state, nowMs)
  const dueMs = toMs(state.nextReviewAt)
  let score = risk
  if (dueMs !== null && nowMs > dueMs) {
    score += Math.min((nowMs - dueMs) / DAY_MS / 7, 0.25)
  }
  if (options.hasError) score += 0.2
  const lapses = Number(state.lapseCount) || 0
  if (lapses > 0) score += Math.min(0.1 * lapses, 0.2)
  return clamp(score, 0, 1)
}

/**
 * Resolve one review's 0..1 quality. An explicit quality wins; otherwise the
 * outcome names it, and hints and extra attempts each cost something — a
 * hinted correct answer is weaker evidence than an independent one.
 */
export function resolveQuality(evidence) {
  const hints = Math.max(0, Number(evidence?.hintsUsed) || 0)
  const attempts = Math.max(1, Number(evidence?.attemptCount) || 1)
  let quality
  if (evidence?.quality !== undefined && evidence?.quality !== null && Number.isFinite(Number(evidence.quality))) {
    quality = Number(evidence.quality)
  } else {
    quality = evidence?.result === 'correct' ? 1 : evidence?.result === 'partial' ? 0.4 : 0
    quality -= Math.min(0.25, hints * 0.08)
    quality -= Math.min(0.2, Math.max(0, attempts - 1) * 0.05)
  }
  return clamp(quality, 0, 1)
}

/**
 * Apply one review to a repetition state and return the next state.
 * Pure: the input state is not modified.
 */
export function scheduleReview(inputState, type, evidence, nowMs) {
  const state = hydrate(inputState, type)
  const eventMs = toMs(evidence?.timestamp) ?? nowMs
  const lastMs = toMs(state.lastReviewAt)
  // A delayed cross-surface write keeps its source timestamp for audit, but it
  // must never move the learner's last review backwards in time.
  const moment = lastMs !== null ? Math.max(eventMs, lastMs) : eventMs
  const quality = resolveQuality(evidence)
  const intervals = INTERVAL_SEQUENCES[type] ?? INTERVAL_SEQUENCES.memory
  const maxIndex = intervals.length - 1

  const previousStability = Math.max(Number(state.stability) || 0, EPS)
  const previousRetrievability = retrievability(state, moment)
  const elapsedDays = lastMs !== null ? Math.max(0, moment - lastMs) / DAY_MS : 0
  const sameSessionDays = Math.min(
    SAME_SESSION_DAYS,
    intervalFromStability(previousStability, DESIRED_RETENTION.default) * 0.5,
  )

  // Practice inside one session refreshes recall, but must not repeatedly
  // multiply stability or postpone the original review deadline.
  if (lastMs !== null && elapsedDays < sameSessionDays) {
    if (quality >= FAIL_QUALITY) {
      return {
        ...state,
        reviewCount: state.reviewCount + 1,
        lastReviewAt: toIso(moment),
        retrievability: 1,
        consecutiveWrong: 0,
      }
    }
    if (state.scheduledAfterFailure && (evidence?.result === 'partial' || evidence?.assessmentType === 'qualitative')) {
      return {
        ...state,
        reviewCount: state.reviewCount + 1,
        lastReviewAt: toIso(moment),
        retrievability: Math.max(quality, 0.2),
      }
    }
  }

  const spacingRatio = Math.min(elapsedDays / previousStability, 4)

  // Difficulty is an item-and-learner estimate, not the type category:
  // surprising failures raise it, strong retrieval lowers it.
  const outcomeError = 1 - quality - state.difficulty
  const surprise = previousRetrievability - quality
  const difficulty = clamp(state.difficulty + 0.12 * outcomeError + 0.08 * surprise, 0.05, 0.95)

  const next = { ...state, difficulty }

  if (quality < FAIL_QUALITY) {
    next.consecutiveWrong = (Number(state.consecutiveWrong) || 0) + 1
    next.consecutiveCorrect = 0
    next.lapseCount = (Number(state.lapseCount) || 0) + 1
    // Forgetting something predicted to be retrievable is a stronger negative
    // update, and a hard item recovers less of its prior stability.
    const retentionFactor = 0.55 - 0.25 * previousRetrievability
    const difficultyFactor = 1 - 0.25 * difficulty
    next.stability = Math.max(MIN_STABILITY_DAYS * 0.1, previousStability * retentionFactor * difficultyFactor)
    next.retrievability = Math.max(quality, 0.2)
    if (next.consecutiveWrong >= 2) next.consecutiveWrong = 0
  } else {
    next.consecutiveWrong = 0
    next.consecutiveCorrect = (Number(state.consecutiveCorrect) || 0) + 1
    const retrievalEffort = 1 + (1 - previousRetrievability) * 1.5
    const spacingBonus = 1 + spacingRatio * 0.15
    const learnability = 1.35 - 0.6 * difficulty
    const qualityStrength = Math.max(0, (quality - FAIL_QUALITY) / (1 - FAIL_QUALITY))
    let growth = 1 + qualityStrength * learnability * retrievalEffort * spacingBonus
    if (quality >= 0.8 && next.consecutiveCorrect >= 2) growth *= 1.15
    next.stability = Math.max(MIN_STABILITY_DAYS, previousStability * growth)
    next.retrievability = 1
    if (next.consecutiveCorrect >= 2) next.consecutiveCorrect = 0
  }

  next.reviewCount = (Number(state.reviewCount) || 0) + 1
  next.lastReviewAt = toIso(moment)
  next.lastScheduledAt = toIso(moment)
  next.scheduledAfterFailure = quality < FAIL_QUALITY
  const intervalDays = scheduledIntervalDays(next, type)
  next.nextReviewAt = toIso(moment + intervalDays * DAY_MS)
  next.intervalIndex = snapIntervalIndex(intervals, intervalDays)
  return next
}

/** Rebuild a state from scratch by replaying evidence in order. */
export function replay(type, evidence, options = {}) {
  const events = Array.isArray(evidence) ? [...evidence] : []
  if (events.length === 0) {
    return initialRepetitionState(type, options.nowMs ?? Date.now(), options.desiredRetention)
  }
  let state = initialRepetitionState(type, toMs(events[0].timestamp) ?? Date.now(), options.desiredRetention)
  for (const event of events) {
    state = scheduleReview(state, type, event, toMs(event.timestamp) ?? Date.now())
  }
  return state
}

/** The plain-language reason a review is being asked for. */
export function reviewReason(state, options = {}) {
  const nowMs = options.nowMs ?? Date.now()
  const parts = []
  const dueMs = toMs(state.nextReviewAt)
  if (dueMs !== null) {
    const delta = nowMs - dueMs
    if (delta >= DAY_MS) {
      const days = Math.round(delta / DAY_MS)
      parts.push(`已逾期 ${days} 天`)
    } else if (delta >= 0) {
      parts.push('今天到期')
    } else {
      const days = Math.round(-delta / DAY_MS)
      parts.push(days <= 0 ? '今天到期' : `${days} 天后到期`)
    }
  }
  const recall = retrievability(state, nowMs)
  const desired = state.desiredRetention || DESIRED_RETENTION.default
  parts.push(
    recall + 1e-9 < desired
      ? `可提取性 ${Math.round(recall * 100)}% 低于目标 ${Math.round(desired * 100)}%`
      : `可提取性 ${Math.round(recall * 100)}%`,
  )
  const lapses = Number(state.lapseCount) || 0
  if (lapses > 0) parts.push(`已遗忘 ${lapses} 次`)
  else if (options.hasError) parts.push('有未解决的错题')
  return parts.join(' · ')
}

/**
 * One review task per knowledge point, most urgent first: higher forgetting
 * risk, then more overdue, then lower priority number.
 */
export function buildReviewQueue(input) {
  const nowMs = input.nowMs ?? Date.now()
  const errorIds = input.errorKpIds ?? new Set()
  const tasks = []
  for (const [kpId, rawState] of Object.entries(input.states ?? {})) {
    const type = isType(input.types?.[kpId]) ? input.types[kpId] : 'memory'
    const state = hydrate(rawState, type)
    const hasError = errorIds.has(kpId)
    const dueMs = toMs(state.nextReviewAt) ?? nowMs
    tasks.push({
      id: `review_${kpId}`,
      knowledgePointId: kpId,
      knowledgeType: type,
      dueAt: state.nextReviewAt,
      dueMs,
      overdueDays: Math.max(0, (nowMs - dueMs) / DAY_MS),
      state,
      hasError,
      priority: hasError ? 1 : TYPE_PRIORITY[type] ?? 2,
      forgettingRisk: Math.round(forgettingRisk(state, { nowMs, hasError }) * 10000) / 10000,
      reason: reviewReason(state, { nowMs, hasError }),
    })
  }
  tasks.sort((a, b) => b.forgettingRisk - a.forgettingRisk || b.overdueDays - a.overdueDays || a.priority - b.priority)
  return tasks
}

/* -------------------------------------------------------------- default */

export const ENGINE = {
  KNOWLEDGE_TYPES,
  QUALITATIVE_TYPES,
  ERROR_TYPES,
  STAGES,
  INTERVAL_SEQUENCES,
  DESIRED_RETENTION,
}
