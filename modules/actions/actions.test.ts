/**
 * Action validation tests - Run: npx tsx modules/actions/actions.test.ts
 *
 * Note: Structure checks (required fields, types) are enforced by TypeScript.
 * These tests validate runtime constraints that TS cannot check.
 */
import mustache from 'mustache';
import { actionsRegistry, BROWSER_ROUTER } from './index.js';
import type { Action, LLMStep, ActionStep } from './types/index.js';

let failed = 0;
const assert = (cond: boolean, msg: string): void => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    failed++;
  }
};

// Extract top-level template variables using Mustache's parser
// Skips variables inside sections ({{#array}}...{{/array}}) since those are item properties
const extractVars = (str: string): Set<string> => {
  const vars = new Set<string>();
  for (const token of mustache.parse(str)) {
    // token[0] = type: 'name', '&', '#', '^', etc.
    // token[1] = variable name
    // 'name'/'&' = variable, '#'/'^' = section (also needs to exist in context)
    if (['name', '&', '#', '^'].includes(token[0])) {
      vars.add(token[1]);
    }
  }
  return vars;
};

// Verify entry point action exists
assert(!!actionsRegistry[BROWSER_ROUTER], `BROWSER_ROUTER not found`);

for (const [name, action] of Object.entries(actionsRegistry) as [string, Action][]) {
  // Registry key must match action name
  assert(action.name === name, `${name}: name mismatch`);

  const availableVars = new Set(Object.keys(action.input_schema.properties || {}));
  availableVars.add('parent_messages');

  let hasFunctionStep = false;
  for (const [i, step] of action.steps.entries()) {
    const id = `${name}.steps[${i}]`;

    if (step.type === 'function') {
      hasFunctionStep = true;
    }

    if (step.type === 'action') {
      // Referenced action must exist in registry
      assert(!!actionsRegistry[(step as ActionStep).action], `${id}: references unknown action "${(step as ActionStep).action}"`);
      hasFunctionStep = true;
    }

    if (step.type === 'llm') {
      const llmStep = step as LLMStep;
      const hasSchema = !!llmStep.output_schema;
      const hasChoice = !!llmStep.tool_choice;

      // Must have exactly one of output_schema or tool_choice
      assert(hasSchema !== hasChoice, `${id}: must have exactly one of output_schema or tool_choice`);

      // Validate template variables (only if no function step preceded)
      if (!hasFunctionStep) {
        const stepVars = new Set([...availableVars, 'current_datetime', 'browser_state', ...(hasChoice ? ['decisionGuide', 'stop_action'] : [])]);
        for (const v of [...extractVars(llmStep.system_prompt), ...extractVars(llmStep.message)]) {
          assert(stepVars.has(v), `${id}: unknown variable {{${v}}}`);
        }
      }

      if (hasSchema) {
        Object.keys(llmStep.output_schema?.properties || {}).forEach(k => availableVars.add(k));
      }
    }

    if ((step as LLMStep).tool_choice) {
      const { available_actions, stop_action, max_iterations } = (step as LLMStep).tool_choice!;
      assert(max_iterations > 0, `${id}: invalid max_iterations`);
      assert(available_actions.includes(stop_action), `${id}: stop_action not in available_actions`);
      // All referenced actions must exist
      for (const a of available_actions) {
        assert(!!actionsRegistry[a], `${id}: unknown action "${a}"`);
      }
    }
  }
}

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
} else {
  console.log('All action validations passed');
}
