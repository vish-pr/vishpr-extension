# DevTools Debug Panel Design

## Overview

A Chrome DevTools panel for debugging Vishpr extension actions. Allows running individual actions against the current tab with full trace visibility.

## Requirements

- **Location**: Chrome DevTools panel (like React DevTools)
- **Trace level**: Full trace with timing (input, output, errors, steps, LLM calls, context accumulation, chrome API calls)
- **Input**: Command input with autocomplete dropdown for action names
- **Context**: Current tab context (no conversation history)
- **Output**: Tree view with collapsible nodes
- **History**: Session history (kept while DevTools open)

## File Structure

### New Files

```
extension/
├── devtools.html          # DevTools entry point
├── devtools.js            # Panel registration
├── devtools-panel.html    # Panel UI
├── devtools-panel.js      # Panel logic (input, tree, history)
├── devtools-panel.css     # Panel styles
└── modules/
    └── trace-collector.js # Instrumentation class
```

### Modified Files

```
├── manifest.json          # Add devtools_page
├── modules/executor.js    # Add tracing hooks
└── background.js          # Handle DEBUG_EXECUTE messages
```

## UI Components

### Command Input

- Text input at top of panel
- Autocomplete dropdown showing matching action names as user types
- Shows action description in dropdown for context
- Format: `ACTION_NAME {"param": "value"}`
- Schema hint displayed below input
- Run button + keyboard shortcut (Enter to run, Ctrl+Enter to run and keep input)

### Tree View Trace

```
▼ READ_PAGE [523ms] ✓
  ├─ Input: {}
  ├─▼ Step 1: extractContent [45ms] ✓
  │   ├─ Type: function
  │   ├─ Handler: chrome.extractContent
  │   ├─ Chrome API: tabs.sendMessage [32ms]
  │   └─ Result: {title: "...", text: "...", links: [...]}
  ├─▼ Step 2: CLEAN_CONTENT [470ms] ✓
  │   ├─ Type: action
  │   ├─▼ Step 2.1: LLM Call [465ms] ✓
  │   │   ├─ Model: gpt-4o-mini
  │   │   ├─ Prompt: "Clean and summarize..."
  │   │   ├─ Tokens: 1,240 in / 89 out
  │   │   └─ Response: {summary: "..."}
  │   └─ Result: {cleaned_content: "..."}
  ├─ Context After: {page_content: "...", summary: "..."}
  └─ Final Output: {content: "...", summary: "..."}
```

Node types with visual distinction:
- **Action** - Blue icon, shows name + total duration
- **Step** - Gray, shows step type (function/llm/action)
- **Chrome API call** - Orange, shows method name
- **LLM call** - Purple, shows model + token counts
- **Context** - Green, shows accumulated state

Status indicators: ✓ success (green), ✗ error (red), ⏳ running (animated)

### Session History

Sidebar/list showing past runs:
- Action name
- Timestamp
- Status (success/error)
- Duration or error summary
- Click to load trace
- Clear History button

## Instrumentation

### TraceCollector Class

Created at start of each debug execution, passed through `executeAction` calls.

### Instrumentation Points

1. **Action start/end** - Wrap `executeAction()` to record timing
2. **Step execution** - Before/after each step in the loop
3. **Context snapshots** - Capture context object after each step
4. **LLM calls** - Wrap `generate()` to capture prompt, response, tokens, timing
5. **Chrome API** - Wrap `getChromeAPI()` handlers to log calls

### Communication Flow

```
DevTools Panel
    ↓ chrome.runtime.sendMessage({type: "DEBUG_EXECUTE", action, params})
Background Service Worker
    ↓ executeAction() with TraceCollector
    ↓ chrome.runtime.sendMessage({type: "DEBUG_TRACE_UPDATE", node})
DevTools Panel (receives incremental updates)
```

Incremental updates allow real-time tree building as steps execute.
