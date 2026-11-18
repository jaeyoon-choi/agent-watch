import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

const USAGE = {
  input_tokens: 10, output_tokens: 5,
  cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
}

// What the Agent tool hands agent.spawn; the engine fills these in a session.
function spawn(prompt: string, description: string, subagentType: string) {
  return {
    prompt, description, subagentType, tool_use_id: 'toolu_1',
    provider: { plugin: 'engine', tier: 'core' as const },
    parentModel: 'claude-opus-5-5', background: true, fork: false,
  }
}

type Agent = { id: string; description: string; type: string; status: 'running' | 'completed' }
type Status = {
  updatedAt: number
  agents: {
    status: string; description: string; summary: string | null; toolCount: number
    isWorkflow: boolean; progress: { pct: number; label: string } | null
  }[]
}

// Stands in for the engine beneath the mod. `listed` and `reply` are read on
// every call, so a test changes them as it goes.
function engine(on: On, world: { listed: Agent[]; reply: string; agentId: string }) {
  const writes: { path: string; text: string }[] = []
  const asked: string[] = []
  let taskIds = 0
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.id', () => ({ value: 'S1' }))
  on('process.run', (_, e) => ({
    value: {
      exitCode: 0, stdout: e.argv.join(' ') === 'id -u' ? '501\n' : '', stderr: '',
      isStdoutTruncated: false, isStderrTruncated: false,
    },
  }))
  on('fs.write', (_, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: world.agentId }))
  on('tool.call', (_, e) =>
    e.tool === 'TaskCreate'
      ? ({ result: { task: { id: String(++taskIds), subject: e.subject } } } as never)
      : ({ result: {} }))
  // Only the fields the mod reads; the engine's AgentInfo has more.
  on('agent.list', () => ({ value: world.listed as never }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('model.complete', (_, e) => {
    asked.push(e.model)
    return { value: { isAnswered: true as const, text: world.reply, usage: USAGE } }
  })
  const status = (): Status => JSON.parse(writes[writes.length - 1]?.text ?? '{"agents":[]}')
  return { writes, asked, status }
}

test('a running agent is written with its Haiku phrase and estimate', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const world = {
    agentId: 'a1', reply: '40|statusline 필드를 찾는 중',
    listed: [{ id: 'a1', description: 'find fields', type: 'Explore', status: 'running' as const }],
  }
  const eng = engine(on, world)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawn('Find the fields', 'find fields', 'Explore'))
  await $.tool.call({ tool: 'Bash', command: 'grep -rn statusline /opt', agentId: 'a1' })
  await clock.advance(5_000)

  expect(eng.asked).toEqual(['haiku'])
  // The tick writes before it asks Haiku, so the phrase lands on the next one.
  await clock.advance(5_000)
  expect(eng.writes[eng.writes.length - 1]?.path).toBe('/tmp/claude-501/agent-watch/S1.json')
  const [a] = eng.status().agents
  expect(a?.description).toBe('find fields')
  expect(a?.summary).toBe('statusline 필드를 찾는 중')
  expect(a?.progress).toEqual({ pct: 40, label: '~40%' })
  expect(a?.toolCount).toBe(1)
})

test('a reply without a percent keeps the whole phrase and no estimate', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const world = {
    agentId: 'a2', reply: '문서를 읽는 중',
    listed: [{ id: 'a2', description: 'read docs', type: 'general-purpose', status: 'running' as const }],
  }
  const eng = engine(on, world)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawn('Read', 'read docs', 'general-purpose'))
  await $.tool.call({ tool: 'Read', file_path: '/tmp/a.md', agentId: 'a2' })
  await clock.advance(10_000)

  const [a] = eng.status().agents
  expect(a?.summary).toBe('문서를 읽는 중')
  expect(a?.progress).toBeNull()
})

test('no Haiku call without new tool calls; an ended agent leaves after 60 s', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const world = {
    agentId: 'a3', reply: '50|문서를 읽는 중',
    listed: [{ id: 'a3', description: 'read docs', type: 'general-purpose', status: 'running' as 'running' | 'completed' }],
  }
  const eng = engine(on, world)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawn('Read', 'read docs', 'general-purpose'))
  await $.tool.call({ tool: 'Read', file_path: '/tmp/a.md', agentId: 'a3' })
  await clock.advance(60_000)
  expect(eng.asked.length).toBe(1)

  world.listed = [{ ...world.listed[0]!, status: 'completed' }]
  await clock.advance(5_000)
  expect(eng.status().agents[0]?.status).toBe('completed')
  expect(eng.status().agents[0]?.progress?.label).toBe('100%')

  // The list still names a3 for a while; it must not come back as new, and
  // the empty file is written once, not every tick.
  await clock.advance(70_000)
  expect(eng.status().agents).toEqual([])
  const count = eng.writes.length
  await clock.advance(70_000)
  expect(eng.writes.length).toBe(count)
})

test('a workflow agent ends with its turn, not with the idle fallback', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const eng = engine(on, { agentId: 'w1', reply: '로그를 읽는 중', listed: [] })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({
    ...spawn('Review', 'review:bugs', 'general-purpose'),
    workflow: { runId: 'wf_abc123', agentIndex: 1 },
  })
  await $.tool.call({ tool: 'Read', file_path: '/tmp/log.txt', agentId: 'w1' })
  // A minute with no tool call: thinking, not ended.
  await clock.advance(60_000)
  expect(eng.status().agents[0]?.status).toBe('running')
  expect(eng.status().agents[0]?.isWorkflow).toBe(true)

  await $.turn.complete({
    answer: 'done', durationMs: 60_000, isAborted: false, turnId: 't1',
    agentId: 'w1', reason: 'answer',
  })
  await clock.advance(5_000)
  expect(eng.status().agents[0]?.status).toBe('completed')
})

test('the task list beats the estimate', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const eng = engine(on, {
    agentId: 'a6', reply: '90|버그를 고치는 중',
    listed: [{ id: 'a6', description: 'fix bugs', type: 'general-purpose', status: 'running' }],
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawn('Fix', 'fix bugs', 'general-purpose'))
  for (const subject of ['one', 'two', 'three']) {
    await $.tool.call({ tool: 'TaskCreate', subject, description: subject, agentId: 'a6' })
  }
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed', agentId: 'a6' })
  await clock.advance(10_000)

  expect(eng.status().agents[0]?.progress).toEqual({ pct: 33, label: '1/3' })
})

// Props of the engine's agent row, with only the fields the mod reads.
function agentRow(id: string, description: string, columns: number) {
  return {
    id, description, type: 'Explore', status: 'running', startTime: 1_000_000,
    rowIds: [id], columns, isHidden: false,
  } as never
}

const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '')

test('the agent row shows the robot, the bar, the phrase and the tool count', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const world = {
    agentId: 'a1', reply: '40|statusline 필드를 찾는 중',
    listed: [{ id: 'a1', description: 'find fields', type: 'Explore', status: 'running' as const }],
  }
  engine(on, world)
  const bodies: string[] = []
  on('ui.render', { component: 'AgentRow' }, async (_, e, next) => {
    bodies.push(e.props.body ?? '')
    return next(e)
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawn('Find the fields', 'find fields', 'Explore'))
  await $.tool.call({ tool: 'Bash', command: 'grep -rn statusline /opt', agentId: 'a1' })
  await clock.advance(65_000)

  await $.ui.render({ surface: 'terminal', component: 'AgentRow', requestId: 'a1', props: agentRow('a1', 'find fields', 120) })
  expect(plain(bodies[0] ?? '')).toBe('🤖 ███▎     ~40%  find fields  statusline 필드를 찾는 중  1m05s · 1 tools')

  // A narrow row cuts the phrase, not the time and the tool count, and a
  // row too narrow for 8 cells of it leaves the phrase out.
  await $.ui.render({ surface: 'terminal', component: 'AgentRow', requestId: 'a1', props: agentRow('a1', 'find fields', 60) })
  expect(plain(bodies[1] ?? '')).toBe('🤖 ███▎     ~40%  find fields  statusline…  1m05s · 1 tools')
  await $.ui.render({ surface: 'terminal', component: 'AgentRow', requestId: 'a1', props: agentRow('a1', 'find fields', 52) })
  expect(plain(bodies[2] ?? '')).toBe('🤖 ███▎     ~40%  find fields  1m05s · 1 tools')
})

test('a fraction reply gives the estimate too', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const world = {
    agentId: 'a1', reply: '5/7 done. sleep 명령 5개 실행',
    listed: [{ id: 'a1', description: 'run commands', type: 'Explore', status: 'running' as const }],
  }
  const eng = engine(on, world)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawn('Run seven commands', 'run commands', 'Explore'))
  await $.tool.call({ tool: 'Bash', command: 'sleep 15 && date', agentId: 'a1' })
  await clock.advance(10_000)

  const [a] = eng.status().agents
  expect(a?.progress).toEqual({ pct: 71, label: '~71%' })
  expect(a?.summary).toBe('done. sleep 명령 5개 실행')
})
