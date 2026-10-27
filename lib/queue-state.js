/* 排队条的唯一模型：宿主 inbox 的 `next-turn` 列表镜像。
 *
 * 为什么单独抽出来：宿主有**两类**事件都会告诉我们 inbox 变了，
 *   1. session 事件 `agent/inbox/spliced`  —— 带 `target`（next-turn / next-step），
 *      是一次 splice 的增量描述（start / removedCount / inserted）；
 *   2. agent 事件 `agent/inbox/inserted` / `claimed` / `discarded` —— 只带一条 message，
 *      **不带 target**。
 *
 * 语义要点（踩过的坑）：
 *   - `next-step` 是"下一步边界要吃掉"的插话/注入消息，它**不是排队消息**，
 *     一旦出现在手机的「排队」框里，用户点编辑/删除/插话都会打到宿主的
 *     next-step 副本上，表现为"消息一直挂着 + queued item is no longer pending"。
 *     所以 spliced 的 next-step 分支只记录 id，不显示。
 *   - `agent/inbox/inserted` 不带 target：靠上面记录的 next-step id 集合把它过滤掉，
 *     只有真正进 next-turn 的消息才显示。
 *   - 索引式 splice 只用来处理 next-turn（顺序与宿主一致）；插入/移除再用 id 去重，
 *     避免索引漂移留下幽灵行。
 */

const STEP_ID_LIMIT = 256

/**
 * @param {object} options
 * @param {(message: unknown) => string} options.textOf 取消息正文（空正文不显示）
 * @param {() => number} [options.now]
 */
export function createQueueState({ textOf, now = () => Date.now() }) {
  const rows = new Map()
  const stepIds = new Map()
  const stepOrder = new Map()
  /**
   * 已"本地先摘掉"但宿主还没发 splice 的条目：{ itemId -> 到期时间 }。
   *
   * 为什么需要它（真 bug）：用户点「插话」时我们立刻把这条从手机列表里摘掉，
   * 但宿主随后才会发 `spliced{target:'next-turn', start:0, removedCount:1}` ——
   * 那个 `start` 是**宿主侧的索引**，此时我们本地已经少了一条，索引就指向了
   * 后一条，于是第二条被误删；有 N 条时会把整列都带走（用户报的"插话一条、
   * 全部消失"）。
   *
   * 所以：本地只"隐藏"，不真删。splice 仍然作用在完整（raw）列表上，
   * 索引永远与宿主一致；宿主真正移除后再由 gone()/splice 清掉隐藏标记。
   */
  const hidden = new Map()
  const HIDE_TTL_MS = 15000

  const toRow = (message) => {
    const itemId = message && message.id ? String(message.id) : ''
    const text = itemId ? String(textOf(message) || '') : ''
    if (!itemId || !text) return null
    return { itemId, text, at: now() }
  }

  const dedupe = (list) => {
    const seen = new Set()
    const out = []
    for (const row of list) {
      if (!row || !row.itemId || seen.has(row.itemId)) continue
      seen.add(row.itemId)
      out.push(row)
    }
    return out
  }

  const hiddenSet = (sessionId) => {
    let map = hidden.get(sessionId)
    if (!map) {
      map = new Map()
      hidden.set(sessionId, map)
    }
    const cutoff = now()
    for (const [id, until] of map) {
      if (until <= cutoff) map.delete(id)
    }
    return map
  }

  /** 完整列表（含"本地已摘掉但宿主还没确认"的条目），只给 splice 用。 */
  const raw = (sessionId) => rows.get(sessionId) || []

  const rememberStep = (sessionId, itemId) => {
    if (!itemId) return
    let set = stepIds.get(sessionId)
    if (!set) {
      set = new Set()
      stepIds.set(sessionId, set)
      stepOrder.set(sessionId, [])
    }
    if (set.has(itemId)) return
    set.add(itemId)
    const order = stepOrder.get(sessionId)
    order.push(itemId)
    if (order.length > STEP_ID_LIMIT) {
      const dropped = order.shift()
      set.delete(dropped)
    }
  }

  return {
    /** 这个会话的队列模型是否已经建立（GET /api/queue 用它决定要不要重建）。 */
    has(sessionId) {
      return rows.has(sessionId)
    },

    list(sessionId) {
      const all = raw(sessionId)
      const map = hiddenSet(sessionId)
      if (map.size === 0) return all
      return all.filter((row) => !map.has(row.itemId))
    },

    /** 当前有队列行的会话 id（推送通道建立时用来补一份快照）。 */
    sessions() {
      return [...rows.keys()]
    },

    /** 整体替换（/api/queue 的 edit/remove 或 rebuildQueue 用）。 */
    set(sessionId, list) {
      const clean = dedupe((Array.isArray(list) ? list : []).filter((row) => row && row.itemId))
      if (clean.length) rows.set(sessionId, clean)
      else rows.delete(sessionId)
      return clean
    },

    /** 按 id 摘掉一行（宿主说它已经不在队列里时用）。 */
    drop(sessionId, itemId) {
      if (!itemId) return this.list(sessionId)
      const id = String(itemId)
      hidden.get(sessionId)?.delete(id)
      return this.set(sessionId, this.list(sessionId).filter((row) => row.itemId !== id))
    },

    /**
     * 手机点了「插话/删除」，但宿主的 splice 还没到：先隐藏，不动 raw。
     * 这样宿主的索引式 splice 仍然作用在完整列表上，不会误删别的行。
     */
    hide(sessionId, itemId) {
      if (!itemId) return this.list(sessionId)
      hiddenSet(sessionId).set(String(itemId), now() + HIDE_TTL_MS)
      return this.list(sessionId)
    },

    /** 这条消息是不是"下一步边界"的消息（不该出现在排队框里）。 */
    isStepMessage(sessionId, itemId) {
      const set = stepIds.get(sessionId)
      return set ? set.has(String(itemId)) : false
    },

    /** 应用 session 事件 `agent/inbox/spliced`。 */
    applySpliced(sessionId, data) {
      const inserted = (Array.isArray(data?.inserted) ? data.inserted : []).map(toRow).filter(Boolean)
      if (data?.target === 'next-step') {
        for (const row of inserted) rememberStep(sessionId, row.itemId)
        return this.list(sessionId)
      }
      // 关键：splice 的 start/removedCount 是**宿主侧索引**，必须作用在完整列表上，
      // 否则本地先隐藏/删掉的条目会让索引左移，连带删掉后面的排队消息。
      const current = raw(sessionId)
      const start = Number.isInteger(data?.start) ? Math.max(0, data.start) : current.length
      const removed = Number.isInteger(data?.removedCount) ? Math.max(0, data.removedCount) : 0
      if (removed === 0 && inserted.length === 0) return this.list(sessionId)
      const next = current.slice()
      next.splice(start, removed, ...inserted)
      this.set(sessionId, next)
      // 宿主已经确认这些条目离开队列，隐藏标记可以撤掉，避免它过期后"复活"。
      const map = hidden.get(sessionId)
      if (map) {
        for (const row of current.slice(start, start + removed)) map.delete(row.itemId)
        for (const row of inserted) map.delete(row.itemId)
        for (const row of next) if (!map.has(row.itemId)) map.delete(row.itemId)
      }
      return this.list(sessionId)
    },

    /** 应用 agent 事件 `agent/inbox/inserted`（不带 target，靠 next-step 集合过滤）。 */
    inserted(sessionId, message) {
      const row = toRow(message)
      if (!row) return this.list(sessionId)
      if (this.isStepMessage(sessionId, row.itemId)) return this.list(sessionId)
      const next = raw(sessionId).filter((item) => item.itemId !== row.itemId)
      next.push(row)
      return this.set(sessionId, next)
    },

    /** 应用 agent 事件 `agent/inbox/claimed` / `agent/inbox/discarded`。 */
    gone(sessionId, itemId) {
      if (!itemId) return this.list(sessionId)
      const id = String(itemId)
      hidden.get(sessionId)?.delete(id)
      const order = stepOrder.get(sessionId)
      const set = stepIds.get(sessionId)
      if (set?.delete(id) && order) {
        const index = order.indexOf(id)
        if (index >= 0) order.splice(index, 1)
      }
      return this.drop(sessionId, id)
    },
  }
}
