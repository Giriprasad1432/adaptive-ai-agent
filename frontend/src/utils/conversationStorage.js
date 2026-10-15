const STORAGE_KEY = 'studypilot_conversations'
const ACTIVE_CONVO_KEY = 'studypilot_active_convo_id'

export const DEFAULT_GREETING_MESSAGE = {
  role: 'assistant',
  content: "Hi Alex! 👋\n\nI'm your StudyPilot AI tutor. What would you like to learn, and what is your goal?",
  quickReplies: [
    "Learn a new subject",
    "Prepare for an exam",
    "Build programming skills",
    "Improve my weak topics",
    "Create a study plan"
  ],
  timestamp: 'Just now'
}

export function generateTitle(text) {
  if (!text || typeof text !== 'string') return 'New Conversation'
  const cleaned = text.replace(/^[^a-zA-Z0-9]+/, '').trim()
  const firstSentence = cleaned.split(/[.\n?!]/)[0].trim()
  if (firstSentence.length <= 32) return firstSentence || 'New Conversation'
  const words = firstSentence.split(/\s+/).slice(0, 5).join(' ')
  return words ? `${words}...` : 'New Conversation'
}

export function loadAllConversations() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch (err) {
    console.error('[StudyPilot Storage] Failed to load conversations:', err)
    return []
  }
}

export function saveAllConversations(conversations) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations))
  } catch (err) {
    console.error('[StudyPilot Storage] Failed to save conversations:', err)
  }
}

export function getActiveConversationId() {
  try {
    return localStorage.getItem(ACTIVE_CONVO_KEY) || sessionStorage.getItem('studypilot-conversation-id') || null
  } catch {
    return null
  }
}

export function setActiveConversationId(id) {
  try {
    if (id) {
      localStorage.setItem(ACTIVE_CONVO_KEY, id)
      sessionStorage.setItem('studypilot-conversation-id', id)
    } else {
      localStorage.removeItem(ACTIVE_CONVO_KEY)
      sessionStorage.removeItem('studypilot-conversation-id')
    }
  } catch {
    // Ignore storage errors
  }
}

export function createNewConversationObject(customId = null, title = 'New Chat') {
  const id = customId || crypto.randomUUID()
  return {
    id,
    title,
    messages: [{ ...DEFAULT_GREETING_MESSAGE }],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }
}

export function deleteConversationFromStorage(id) {
  const all = loadAllConversations()
  const filtered = all.filter((c) => c.id !== id)
  saveAllConversations(filtered)
  return filtered
}

export function renameConversationInStorage(id, newTitle) {
  const all = loadAllConversations()
  const updated = all.map((c) => {
    if (c.id === id) {
      return { ...c, title: newTitle.trim() || c.title, updatedAt: new Date().toISOString() }
    }
    return c
  })
  saveAllConversations(updated)
  return updated
}

export function clearAllConversationsFromStorage() {
  try {
    localStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem(ACTIVE_CONVO_KEY)
  } catch {
    // Ignore storage errors
  }
}
