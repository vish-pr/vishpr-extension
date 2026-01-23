/**
 * Reusable context step handlers for actions
 * These fetch runtime context that LLM steps may need
 */
import type { StepContext, StepResult } from './types/index.js';
import { getBrowserStateBundle } from '../chrome-api.js';

// Storage key for user preferences knowledge base
const PREFERENCES_KB_KEY = 'user_preferences_kb';

/**
 * Fetch current browser state (active tab info, page content, etc.)
 */
export async function fetchBrowserState(ctx: StepContext): Promise<StepResult> {
  const browser_state = await getBrowserStateBundle();
  return {
    result: { browser_state }
  };
}

/**
 * Fetch user preferences from storage
 */
export async function fetchUserPreferences(ctx: StepContext): Promise<StepResult> {
  const storage = await chrome.storage.local.get(PREFERENCES_KB_KEY);
  const user_preferences = storage[PREFERENCES_KB_KEY] || '';
  return {
    result: { user_preferences }
  };
}

/**
 * Get current datetime formatted for display
 */
export function fetchCurrentDateTime(ctx: StepContext): StepResult {
  const current_datetime = new Date().toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });
  return {
    result: { current_datetime }
  };
}

/**
 * Combined handler that fetches all common context
 * Use this for actions that need everything
 */
export async function fetchAllContext(ctx: StepContext): Promise<StepResult> {
  const [browser_state, storage] = await Promise.all([
    getBrowserStateBundle(),
    chrome.storage.local.get(PREFERENCES_KB_KEY)
  ]);

  const current_datetime = new Date().toLocaleString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short'
  });

  return {
    result: {
      browser_state,
      user_preferences: storage[PREFERENCES_KB_KEY] || '',
      current_datetime
    }
  };
}
