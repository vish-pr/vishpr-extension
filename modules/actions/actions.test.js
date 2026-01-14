/**
 * Action validation tests - Run: node modules/actions/actions.test.js
 */
import { actionsRegistry, BROWSER_ROUTER } from './index.js';

let failed = 0;
const assert = (cond, msg) => cond || (console.error(`FAIL: ${msg}`), failed++);

const extractVars = str => new Set((str?.match(/\{\{[#^/]?([a-zA-Z_]\w*)\}\}/g) || []).map(m => m.replace(/[{}#^/]/g, '')));

assert(actionsRegistry[BROWSER_ROUTER], `BROWSER_ROUTER not found`);

for (const [name, action] of Object.entries(actionsRegistry)) {
  assert(action.name === name, `${name}: name mismatch`);
  assert(action.description, `${name}: missing description`);
  assert(action.input_schema, `${name}: missing input_schema`);
  assert(action.steps?.length, `${name}: missing steps`);

  const availableVars = new Set(Object.keys(action.input_schema?.properties || {}));
  availableVars.add('messages');

  for (const [i, step] of (action.steps || []).entries()) {
    const id = `${name}.steps[${i}]`;
    const isLLM = step.type === 'llm';

    assert(typeof step === 'function' || isLLM, `${id}: invalid step type`);

    if (isLLM) {
      const hasSchema = !!step.output_schema;
      const hasChoice = !!step.tool_choice;

      assert(hasSchema !== hasChoice, `${id}: must have exactly one of output_schema or tool_choice`);
      assert(step.intelligence, `${id}: missing intelligence`);
      assert(!step.system_prompt || typeof step.system_prompt === 'string', `${id}: system_prompt must be string`);
      assert(step.system_prompt || hasChoice, `${id}: needs system_prompt or tool_choice`);

      const stepVars = new Set([...availableVars, ...(hasChoice ? ['available_tools', 'decision_guide'] : [])]);
      for (const v of [...extractVars(step.system_prompt), ...extractVars(step.message)]) {
        assert(stepVars.has(v), `${id}: unknown variable {{${v}}}`);
      }

      if (hasSchema) Object.keys(step.output_schema.properties || {}).forEach(k => availableVars.add(k));
    }

    if (step.tool_choice) {
      const { available_actions, stop_action, max_iterations } = step.tool_choice;
      assert(stop_action, `${id}: missing stop_action`);
      assert(max_iterations > 0, `${id}: invalid max_iterations`);
      assert(available_actions?.includes(stop_action), `${id}: stop_action not in available_actions`);
      for (const a of available_actions || []) {
        assert(actionsRegistry[a], `${id}: unknown action "${a}"`);
      }
    }
  }
}

failed ? (console.error(`\n${failed} test(s) failed`), process.exit(1)) : console.log('All action validations passed');
