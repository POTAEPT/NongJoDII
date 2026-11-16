// The shape of a file in e2e/scenarios/*.json. Persona keys ("ploy") and scenario message
// ids ("m4") are translated to member and message refs only inside the fake model answer.

export type ScenarioPersona = {
  lineName: string
  role: string | null
  owner?: boolean
  lineUserId: string
}

export type ScenarioChatMessage = { id: string; persona: string; minute: number; text: string }

export type ScenarioCommand = { persona: string; minute: number; text: string }

export type ExpectedTask = {
  title: string
  assignee: string // persona key
  due: string // ISO 8601 instant
  sourceMessage: string // scenario message id
}

export type FakeTask = {
  title: string
  details?: string
  assignee: string | null // persona key
  due: string | null
  source: string | null // scenario message id
}

export type Scenario = {
  name: string
  feature: string
  description: string
  startAt: string
  group: { lineGroupId: string; name: string; workDescription: string }
  personas: Record<string, ScenarioPersona>
  messages: ScenarioChatMessage[]
  summaryCommand: ScenarioCommand
  expectedTasks: ExpectedTask[]
  fakeModelAnswer: { summary: string; tasks: FakeTask[] }
  expect: { storedMessages: number; summaries: number; candidates: number; replyHasReviewButton: boolean }
}
