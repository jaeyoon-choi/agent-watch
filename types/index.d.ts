export type AgentActivity = {
  id: string
  description: string
  type: string
  model: string
  prompt: string
  status: string
  startedAt: number
  lastAt: number
  endedAt: number | null
  steps: string[]
  toolCount: number
  summary: string | null
  summarizedTools: number
  summarizedAt: number
  isListed: boolean
  workflowRun: string | null
  // Haiku's guess, 0 to 100, of how much of the task is done.
  estimate: number | null
  // Task id to status, from the agent's TaskCreate/TaskUpdate/TodoWrite calls.
  tasks: Record<string, string>
}

declare module 'claude-code' {
  interface PluginState {
    'agent-watch': { agents: Shaped<Record<string, AgentActivity>> }
  }
}
