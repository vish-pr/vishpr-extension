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

export interface LLMStep {
  type: 'llm';
  system_prompt: string;
  message: string;
  intelligence: Intelligence;
  output_schema?: JSONSchema;
  tool_choice?: ToolChoice;
  skip_if?: (ctx: StepContext) => boolean;
}

export interface ActionStep {
  type: 'action';
  action: string;
}

export type Step = FunctionStep | LLMStep | ActionStep;

// Full action definition
export interface Action {
  name: string;
  description: string;
  examples?: string[];
  input_schema: JSONSchema;
  steps: Step[];
  post_steps?: Step[];  // Fire-and-forget steps run after result returned (root actions only)
}

// Action registry type
export type ActionsRegistry = Record<string, Action>;
