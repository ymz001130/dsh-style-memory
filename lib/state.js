/**
 * 运行时会话状态（内存）：每轮提示、消息去重、present 门禁计数、已学习配对去重。
 * 进程重启即清空，不落盘；落盘的是档案与快照（见 store.js）。
 */

let counter = 0;

const agents = new Map();

/** 新消息 id（插件注入消息用）。 */
export function nextMessageId() {
  counter += 1;
  return 'style-memory-' + Date.now().toString(36) + '-' + counter;
}

/** 取/建某个 agent 的运行时状态。 */
export function agentState(agentId) {
  const key = String(agentId || 'unknown');
  let state = agents.get(key);
  if (state === undefined) {
    state = {
      turn: -1,
      seenMessages: new Set(),
      present: new Map(),
      learnedPairs: new Set(),
      lastLearnAt: 0,
      learning: false,
      chatMessages: 0
    };
    agents.set(key, state);
  }
  return state;
}

/** 丢弃已结束会话的状态。 */
export function dropAgentState(agentId) {
  agents.delete(String(agentId || 'unknown'));
}

/** 记录一条用户消息 id；重复返回 false。 */
export function rememberMessage(state, messageId) {
  if (typeof messageId !== 'string' || messageId.length === 0) return false;
  if (state.seenMessages.has(messageId)) return false;
  state.seenMessages.add(messageId);
  if (state.seenMessages.size > 800) {
    const oldest = state.seenMessages.values().next().value;
    state.seenMessages.delete(oldest);
  }
  return true;
}

/** 新一轮开始。 */
export function resetTurnState(state, turn) {
  state.turn = Number.isFinite(turn) ? turn : state.turn;
}

/** 取某个文件的 present 门禁记录。 */
export function presentRecord(state, absolutePath) {
  let record = state.present.get(absolutePath);
  if (record === undefined) {
    record = { attempts: 0, lastHash: '', lastScore: 0, lastAt: 0, passedHash: '' };
    state.present.set(absolutePath, record);
  }
  return record;
}

/** 复位某文件的门禁记录。 */
export function clearPresentRecord(state, absolutePath) {
  state.present.delete(absolutePath);
}

/** 构造插件注入的近用户消息（DSH 0.2.1 的 producer-owned source 形状）。 */
export function pluginMessage(text, summary, form) {
  const shortSummary = String(summary || text || '').replace(/\s+/g, ' ').slice(0, 119);
  return {
    id: nextMessageId(),
    role: 'user',
    source: { kind: 'plugin:dsh-style-memory', form: form || 'notice', summary: shortSummary },
    content: [{ type: 'text', text: String(text || '') }]
  };
}

/** 测试/调试用：当前内存状态快照。 */
export function debugAgents() {
  const out = {};
  for (const [key, value] of agents.entries()) {
    out[key] = {
      turn: value.turn,
      seenMessages: value.seenMessages.size,
      presentFiles: value.present.size,
      learnedPairs: value.learnedPairs.size,
      chatMessages: value.chatMessages
    };
  }
  return out;
}
