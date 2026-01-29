/**
 * Lazy context provider for Mustache templates
 * Fetches context variables fresh at render time - no caching
 */
import Mustache from 'mustache';
import { getBrowserStateBundle } from '../content-bridge.js';

const PREFERENCES_KB_KEY = 'user_preferences_kb';
const PREVIOUS_CHAT_KEY = 'previous_chat_context';

type ContextFetcher = () => Promise<unknown>;

/**
 * Registry of context variable fetchers
 * Each fetcher is called fresh every time the variable is needed
 */
const contextFetchers: Record<string, ContextFetcher> = {
  browser_state: () => getBrowserStateBundle(),

  user_preferences: async () => {
    const storage = await chrome.storage.local.get(PREFERENCES_KB_KEY);
    return storage[PREFERENCES_KB_KEY] || '';
  },

  current_datetime: () => Promise.resolve(
    new Date().toLocaleString('en-US', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZoneName: 'short'
    })
  ),

  previous_chat: async () => {
    const storage = await chrome.storage.session.get(PREVIOUS_CHAT_KEY);
    const ctx = storage[PREVIOUS_CHAT_KEY] as {
      tabAlias: string | null;
      tabUrl: string;
      userInput: string;
      modelResponse: string;
      timestamp: number;
    } | undefined;
    if (!ctx) return null;

    const timeSinceMinutes = Math.round((Date.now() - ctx.timestamp) / 60000);
    return {
      tabAlias: ctx.tabAlias,
      tabUrl: ctx.tabUrl,
      userInput: ctx.userInput,
      modelResponse: ctx.modelResponse,
      timeSinceMinutes
    };
  }
};

/**
 * Extract Mustache variable names from template using Mustache's parser
 * Returns top-level variables (name, unescaped, section, inverted section)
 */
function extractTemplateVars(template: string): string[] {
  const vars = new Set<string>();
  for (const token of Mustache.parse(template)) {
    // token[0] = type: 'name', '&', '#', '^', etc.
    // token[1] = variable name
    // 'name'/'&' = variable, '#'/'^' = section (also needs to exist in context)
    if (['name', '&', '#', '^'].includes(token[0] as string)) {
      vars.add(token[1] as string);
    }
  }
  return [...vars];
}

/**
 * Resolve context variables for a template
 * Fetches fresh values for all known context vars used in the template
 */
export async function resolveContextForTemplate(template: string): Promise<Record<string, unknown>> {
  const vars = extractTemplateVars(template);
  const knownVars = vars.filter(v => v in contextFetchers);

  if (knownVars.length === 0) {
    return {};
  }

  const results = await Promise.all(
    knownVars.map(async key => {
      try {
        const value = await contextFetchers[key]();
        return [key, value] as const;
      } catch (e) {
        console.warn(`Failed to fetch context ${key}:`, e);
        return [key, null] as const;
      }
    })
  );

  return Object.fromEntries(results);
}

/**
 * Check if a context variable is known (exact match)
 */
export function isKnownContextVar(name: string): boolean {
  return name in contextFetchers;
}

/**
 * Get list of all known context variable names
 */
export function getKnownContextVars(): string[] {
  return Object.keys(contextFetchers);
}
