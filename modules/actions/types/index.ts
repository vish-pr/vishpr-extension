/**
 * Action system type definitions
 */

// JSON Schema subset for input validation
export interface JSONSchema {
  type: 'object' | 'string' | 'number' | 'boolean' | 'array';
  properties?: Record<string, JSONSchema & { description?: string; enum?: string[] }>;
  items?: JSONSchema;
  required?: string[];
  additionalProperties?: boolean;
  description?: string;
}

// Tool documentation for TOOLS and EXAMPLES sections
export interface ToolDoc {
  use_when: string[];     // Criteria for when to use
  must?: string[];        // Required behaviors
  never?: string[];       // Prohibited behaviors
  examples?: string[];    // Example queries that should use this tool
}

// Message types for conversation
export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

// Context passed to step handlers
export interface StepContext {
  parent_messages?: Message[];
  tabId?: number;
  [key: string]: unknown;
}

// What function step handlers MUST return
export interface StepResult<T = Record<string, unknown>> {
  result: T;
  parent_messages?: Message[];
}

// Intelligence levels for LLM calls
export type Intelligence = 'LOW' | 'MEDIUM' | 'HIGH';

// Tool choice configuration for multi-turn LLM steps
export interface ToolChoice {
  available_actions: string[];
  stop_action: string;
  max_iterations: number;
}

// Step type definitions
export interface FunctionStep {
  type: 'function';
  handler: (ctx: StepContext) => StepResult | Promise<StepResult>;
}

// Base LLM step fields
interface LLMStepBase {
  type: 'llm';
  system_prompt: string;
  message: string;
  intelligence: Intelligence;
  skip_if?: (ctx: StepContext) => boolean;
}

// Single-turn LLM step with structured output
export interface SingleTurnLLMStep extends LLMStepBase {
  output_schema: JSONSchema;
  tool_choice?: never;
  continuation_message?: never;
}

// Multi-turn LLM step with tool choice (continuation_message required)
export interface MultiTurnLLMStep extends LLMStepBase {
  tool_choice: ToolChoice;
  /** Message used after first turn in multi-turn loops. Required for tool_choice steps. */
  continuation_message: string;
  output_schema?: never;
}

export type LLMStep = SingleTurnLLMStep | MultiTurnLLMStep;

export interface ActionStep {
  type: 'action';
  action: string;
  condition?: (ctx: StepContext) => boolean;  // Only execute if returns true
}

export type Step = FunctionStep | LLMStep | ActionStep;

// Full action definition
export interface Action {
  name: string;
  description: string;
  tool_doc?: ToolDoc;     // All tool documentation in one place
  input_schema: JSONSchema;
  steps: Step[];
  post_steps?: Step[];  // Fire-and-forget steps run after result returned (root actions only)
}

// Action registry type
export type ActionsRegistry = Record<string, Action>;
