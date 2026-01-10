# VishPro Browser Extension

A browser extension that leverages large language models (LLMs) to automate web browsing tasks through natural language commands.
Supports multiple LLM providers with intelligent failover, enhanced click actions, browser state tracking, and comprehensive logging.

## Features

- **Multi-Provider LLM**: Google Gemini and OpenRouter with automatic failover
- **Intelligence Levels**: LOW, MEDIUM, and HIGH quality tiers
- **Enhanced Click Actions**: New tab support, downloads via modifiers
- **Browser Automation**: Read pages, click elements, navigate, fill forms
- **Content Extraction**: Analyze and extract webpage content
- **Smart Schema Support**: JSON-structured responses from LLMs
- **Comprehensive Logging**: Tracks all steps, LLM calls, tool calls, and actions

## Quick Start

### 1. Get API Keys

**Option A: Google Gemini (Free tier)**
- Visit [Google AI Studio](https://makersuite.google.com/app/apikey)
- Create API key (starts with `AIza...`)

**Option B: OpenRouter (Pay-as-you-go)**
- Visit [OpenRouter](https://openrouter.ai/)
- Add credits and generate key (starts with `sk-or-...`)

### 2. Install Extension

1. Open `chrome://extensions/`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select this directory
5. Pin extension (optional)

### 3. Configure

1. Click extension icon to open side panel
2. Click settings icon (⚙️)
3. Select provider and enter API key
4. Choose intelligence level (MEDIUM recommended)

## Usage

### Chat Commands

```
Read this page
Click the submit button
Click the GitHub link and open in new tab
Go to https://example.com
Download the PDF file
```

### Intelligence Levels

- **LOW**: Fast, cheap, simple tasks
- **MEDIUM**: Balanced speed and quality (recommended)
- **HIGH**: Best quality, slower, more expensive

## Architecture

```
extension/
├── modules/
│   ├── llm.js              # Unified LLM client with failover
│   ├── llm-config.js       # Model tiers and cascading
│   ├── llm-client.js       # OpenRouter & Gemini API client
│   ├── logger.js           # Logging system with storage
│   ├── browser-state.js    # Browser state tracking & versioning
│   ├── orchestrator/       # Multi-turn action orchestration
│   ├── actions/            # Browser action implementations
│   └── [settings, chat, dom, storage, extraction, etc.]
├── background.js           # Service worker (with tab lifecycle)
├── sidepanel.js/html       # Chat UI
├── content.js              # DOM interaction
└── manifest.json           # Extension config
```

### LLM Provider System

**Model Tiers:**
- **HIGH**: Gemini Pro, Qwen 235B
- **MEDIUM**: GPT OSS 120B, Gemini Flash, Llama 3.3 70B
- **LOW**: Gemini Flash Lite, Qwen 32B

**Cascading Failover:**
1. Try models at requested level
2. Cascade to next lower level on failure
3. Continue until success or exhaustion

**Provider Routing:**
- Google models → `google-ai-studio`
- Fast inference → `Cerebras`

### Enhanced Click Actions

The `CLICK_ELEMENT` action now supports modifiers:

| Modifier | Effect | Browser Behavior |
|----------|--------|------------------|
| `newTab: true` | Ctrl/Cmd+Click | Opens in background tab |
| `newTabActive: true` | Ctrl/Cmd+Shift+Click | Opens in foreground tab |
| `download: true` | Alt+Click | Downloads the link |

**Platform-aware:** Auto-detects Mac (Cmd) vs Windows/Linux (Ctrl)

### Browser State Tracking

The extension automatically tracks all tabs, URLs, and page content, providing the LLM with complete browsing context while optimizing token usage.

**Key Features:**
- **Auto-tracking**: Tabs registered on navigation, cleaned up on close
- **URL History**: Complete navigation timeline per tab
- **Page Snapshots**: Stores title, text, buttons, links, and form inputs from `READ_PAGE` calls
- **Smart Versioning**: When same URL is read twice, old content marked as "updated", new as "current"
- **Token Optimized**: Browser state appears only once (appended to last message) - **60-80% savings**
- **Persistent**: Saved to `chrome.storage` every 60 seconds

**How it works:**

```javascript
// Browser state is appended just before each LLM call
const browserState = getBrowserState();

// LLM sees formatted state
=== BROWSER STATE ===
Tab 123:
  Current URL: https://github.com
  URL History:
    1. https://github.com (2026-01-09T10:00:00Z)
  Page Contents:
    1. [CURRENT] https://github.com
       Title: GitHub
       Text: Where the world builds...
       Buttons: 2 buttons, Links: 15 links
```

**Usage in actions:**

```javascript
import { getBrowserState } from './modules/browser-state.js';

// Register tab
browserState.registerTab(tabId, url);

// Add page content (auto-versions on duplicate URL)
browserState.addPageContent(tabId, url, {
  title: 'Page Title',
  text: 'Content...',
  buttons: [{ text: 'Click', selector: '#btn' }],
  links: [{ text: 'Link', href: '/path' }]
});

// Get formatted state for LLM (done automatically)
const formatted = browserState.formatForChat();

// Get JSON
const json = browserState.toJSON();
```

**Token Optimization:**

Conversation is stored clean, browser state appended just-in-time:

```javascript
// Stored conversation (clean)
[
  { role: 'user', content: 'What is on this page?' },
  { role: 'assistant', content: 'READ_PAGE' },
  { role: 'user', content: 'Result: {...}' }  // No browser state
]

// Sent to LLM (browser state on last message only)
[
  { role: 'user', content: 'What is on this page?' },
  { role: 'assistant', content: 'READ_PAGE' },
  { role: 'user', content: 'Result: {...}\n\n=== BROWSER STATE ===' }
]
```

**Example: Page Update Detection**

```
User refreshes page: "What changed?"

1. chrome.tabs.onUpdated → registers tab
2. LLM chooses READ_PAGE
3. Old content marked "updated", new content added as "current"
4. LLM sees both versions:
   - [UPDATED to timestamp] old content
   - [CURRENT] new content
5. LLM responds: "Notification count changed from 5 to 3"
```

## API Reference

### LLM Client

```javascript
import { generate, isInitialized, setApiKey, INTELLIGENCE_LEVEL } from './modules/llm.js';

// Generate with automatic provider selection (schema is REQUIRED)
const response = await generate({
  messages: [
    { role: 'system', content: 'You are a helpful assistant' },
    { role: 'user', content: 'Hello!' }
  ],
  intelligence: INTELLIGENCE_LEVEL.MEDIUM,
  schema: {
    type: 'object',
    properties: {
      response: { type: 'string', description: 'Your response' }
    },
    required: ['response']
  }
});

// Check if configured
const ready = await isInitialized();

// Set API key
await setApiKey('your-key', 'openrouter'); // or 'gemini'
```

### Structured JSON Responses

**IMPORTANT: Schema is required for all LLM calls.** All responses will be parsed as JSON objects matching the provided schema.

```javascript
// Get structured JSON from LLM
const choice = await generate({
  messages: conversation,
  intelligence: 'MEDIUM',
  schema: {
    type: 'object',
    properties: {
      tool: { type: 'string', enum: ['READ_PAGE', 'CLICK_ELEMENT'] },
      justification: { type: 'string' }
    },
    required: ['tool', 'justification']
  }
});

// Returns parsed object: { tool: 'READ_PAGE', justification: '...' }
```

## API Key Verification

**Automatic verification on key entry:**
- Visual feedback: ⏳ orange (verifying) → ✓ green (valid) / ✗ red (invalid)
- Uses GET request to model endpoint (no token usage)
- Cached in `chrome.storage.local`

**Gemini implementation:**
```javascript
const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash?key=${apiKey}`;
const response = await fetch(endpoint, { method: 'GET' });
return response.ok;
```

## Logging System

The extension includes comprehensive logging that tracks all operations.

### Quick Access

Open browser console and run:

```javascript
// Download all logs
import('./modules/logger.js').then(({ logger }) => {
  logger.downloadLogsFromStorage();
});

// View logs in console
import('./modules/logger.js').then(({ logger }) => {
  console.log(logger.getLogsAsString());
});

// Enable debug mode for detailed LLM inputs/outputs
import('./modules/logger.js').then(({ logger, LogLevel }) => {
  logger.setLogLevel(LogLevel.DEBUG);
});
```

### What Gets Logged

- User messages and orchestration flow
- All LLM calls (provider, model, success/failure)
- LLM inputs/outputs (debug level)
- Action executions and results
- Multi-turn loop iterations and choices
- Errors with stack traces

### Storage

- **Memory**: Last 1000 entries
- **Chrome Storage**: Last 500 entries (persists across reloads)
- All logs also output to console in real-time

## Troubleshooting

**"No LLM provider configured"**
- Add at least one API key in settings
- Verify green checkmark appears

**"All LLM requests failed"**
- Check API key credits/quota
- Try different intelligence level
- Add second provider for failover
- Download logs to see detailed error information

**Extension won't load**
- Check manifest.json is valid
- Open DevTools → Console for errors
- Verify icon.png exists (128x128)

**Click modifiers not working**
- Ensure page contains clickable links
- Check console for modifier logs
- Verify platform detection (Mac vs Windows/Linux)

**Need to debug an issue?**
- Enable debug logging: `logger.setLogLevel(LogLevel.DEBUG)`
- Download logs: `logger.downloadLogsFromStorage()`
- Logs show complete LLM inputs/outputs and execution flow

## Storage Schema

```javascript
{
  geminiApiKey: "AIza...",           // Encrypted by Chrome
  openrouterApiKey: "sk-or-...",     // Encrypted by Chrome
  apiKeyValid: true,                 // Cached validation
  defaultModel: "gemini-2.5-flash",  // Selected model
  intelligence: "MEDIUM",            // Current intelligence level
  extension_logs: [                  // Logging system (last 500 entries)
    "[timestamp] LEVEL - message | data"
  ],
  browserState: {                    // Browser state (persisted every 60s)
    tabs: {
      "123": {
        tabId: 123,
        currentUrl: "https://...",
        urlHistory: [...],
        pageContents: [...]
      }
    }
  }
}
```

## Development

### Adding New Models

Edit `modules/llm-config.js`:

```javascript
export const MODELS = {
  HIGH: [
    ['openrouter', 'new-model-id', { only: ['provider-name'] }],
    // ... existing models
  ]
};
```

### Testing

1. Load extension in Chrome
2. Open DevTools (F12) on side panel
3. Check console for LLM request logs
4. Test failover with invalid API keys

## Recent Enhancements

### Browser State Tracking (modules/browser-state.js)
- Automatic tracking of all tabs, URLs, and page content
- Smart versioning when pages are updated
- Token-optimized: single instance per conversation (60-80% savings)
- Persistent storage every 60 seconds
- Tab lifecycle management (cleanup on close)
- Provides full browsing context to LLM

### Logging System (modules/logger.js)
- Comprehensive logging of all operations
- Multiple log levels (DEBUG, INFO, WARN, ERROR)
- Automatic storage in memory and Chrome storage
- Real-time console output with truncation
- Easy log download and access
- Integrated throughout all modules

### Click Modifiers (content.js, browser-actions.js)
- Platform detection for Mac/Windows/Linux
- New tab and download support
- Backwards compatible with simple clicks

### Schema Support (llm.js)
- **Required for all LLM calls** - schema parameter is mandatory
- JSON Schema mode for OpenRouter with strict validation
- Prompt-based JSON for Gemini with schema hints
- Automatic JSON extraction and parsing
- Complete schema structure passed to API (not just type: json_object)

### Orchestrator
- Multi-turn action loops
- Dynamic tool selection
- Context-aware decision making with browser state

## License

MIT
