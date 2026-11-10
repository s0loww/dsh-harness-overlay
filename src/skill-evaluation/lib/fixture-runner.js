/** Deterministic harness adapter. It does not invoke a model, OS command or network. */
export function createFixtureRunner(execute) {
  if (typeof execute !== 'function') throw new Error('SKILL_EVAL_FIXTURE_REQUIRED')
  return Object.freeze({ kind: 'fixture', execute })
}

/** Declarative deterministic fixture operations, never JavaScript or shell from skill content. */
export function createDeclarativeFixtureRunner(plan) {
  return createFixtureRunner(async ({ task, variant, tools, signal }) => {
    const source = plan.tasks.find(item => item.id === task.id)
    if (!source?.fixtureSteps?.length) throw new Error('SKILL_EVAL_FIXTURE_STEPS_REQUIRED')
    let finalText = ''
    for (const step of source.fixtureSteps) {
      if (signal.aborted) throw new Error('SKILL_EVAL_CANCELLED')
      if (step.whenSkill && !variant.name) continue
      if (step.op === 'read') tools.read(step.path)
      if (step.op === 'read-skill') tools.readSkill(step.path)
      if (step.op === 'write') tools.write(step.path, step.text)
      if (step.op === 'replace') tools.write(step.path, tools.read(step.path).split(step.from).join(step.to))
      if (step.op === 'final') finalText = step.text
    }
    return { finalText }
  })
}
