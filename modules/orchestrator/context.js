/**
 * Context management for orchestrator
 * Manages parameter mapping and validation
 */

/**
 * Map parameters from context to match an action's input schema
 * @param {Object} inputSchema - JSON Schema defining required inputs
 * @param {Object} context - Current context data
 * @returns {Object} Mapped parameters
 */
export function mapParamsFromContext(inputSchema, context) {
  if (!inputSchema || !inputSchema.properties) {
    return context;
  }

  const params = {};
  for (const key of Object.keys(inputSchema.properties)) {
    if (context.hasOwnProperty(key)) {
      params[key] = context[key];
    }
  }

  return params;
}

/**
 * Validate parameters against JSON Schema
 * Simple validation - checks required fields and basic types
 * @param {Object} params - Parameters to validate
 * @param {Object} schema - JSON Schema
 * @returns {Object} { valid: boolean, errors: string[] }
 */
export function validateParams(params, schema) {
  const errors = [];

  // Check required fields
  if (schema.required) {
    for (const field of schema.required) {
      if (!params.hasOwnProperty(field) || params[field] === undefined) {
        errors.push(`Missing required field: ${field}`);
      }
    }
  }

  // Check basic types
  if (schema.properties) {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      if (params.hasOwnProperty(key) && params[key] !== undefined) {
        const value = params[key];
        const expectedType = propSchema.type;

        if (expectedType === 'string' && typeof value !== 'string') {
          errors.push(`Field ${key} must be a string, got ${typeof value}`);
        } else if (expectedType === 'number' && typeof value !== 'number') {
          errors.push(`Field ${key} must be a number, got ${typeof value}`);
        } else if (expectedType === 'boolean' && typeof value !== 'boolean') {
          errors.push(`Field ${key} must be a boolean, got ${typeof value}`);
        } else if (expectedType === 'array' && !Array.isArray(value)) {
          errors.push(`Field ${key} must be an array, got ${typeof value}`);
        } else if (expectedType === 'object' && (typeof value !== 'object' || Array.isArray(value))) {
          errors.push(`Field ${key} must be an object, got ${typeof value}`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
