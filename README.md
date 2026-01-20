# vishpr Browser Agent

Chrome extension that automates web browsing through natural language using LLMs via OpenRouter.

## Install

Download the latest `vishpr-extension-*.zip` from [Releases](https://github.com/vish-pr/vishpr-extension/releases), unzip, and load in `chrome://extensions/` with Developer mode enabled.

## Architecture

```
User Message
    │
    ▼
┌───────────────────────────────────────────────┐
│  Tier-1: Router (router-action.js)            │
│  Routes to: BROWSER_ACTION | LLM_TOOL | SUMMARY_TOOL
└───────────────────────────────────────────────┘
    │
    ▼
┌───────────────────────────────────────────────┐
│  Tier-2: Browser Action Router                │
│  Multi-turn loop with 13 browser actions      │
│  READ_PAGE → CLICK → FILL_FORM → SUMMARY_TOOL │
└───────────────────────────────────────────────┘
```

## Project Structure

```
extension/
├── modules/
│   ├── executor.js           # Action execution with multi-turn LLM support
│   ├── actions/
│   │   ├── index.js          # Central action registry
│   │   ├── router-action.js  # Tier-1 routing
│   │   ├── browser-actions.js # Tier-2 router + 13 browser actions
│   │   ├── llm-action.js     # General knowledge/reasoning
│   │   └── summary-action.js # Final response to user
│   ├── llm.js                # OpenRouter client with model cascading
│   ├── browser-state.js      # Tab/page state management
│   └── logger.js             # Logging
├── content.js                # Page interaction (element IDs, clicks, forms)
├── background.js             # Service worker
├── sidepanel.js/html         # Chat UI
└── manifest.json
```

## Browser Actions

| Action | Description |
|--------|-------------|
| READ_PAGE | Extract content with element IDs |
| CLICK_ELEMENT | Click by element ID (supports new tab, download) |
| FILL_FORM | Fill form fields |
| SELECT_OPTION | Select dropdown option |
| CHECK_CHECKBOX | Toggle checkbox |
| SUBMIT_FORM | Submit form |
| NAVIGATE_TO | Go to URL |
| SCROLL_TO | Scroll (up/down/top/bottom) |
| GET_PAGE_STATE | Get scroll position, viewport info |
| WAIT_FOR_LOAD | Wait for page load |
| WAIT_FOR_ELEMENT | Wait for element to appear |
| GO_BACK / GO_FORWARD | Browser history navigation |

## Setup

1. `npm install`
2. `npm run build`
3. Load `dist/` folder in `chrome://extensions/` (Developer mode)
4. Click extension → Settings → Add OpenRouter API key

## Development

```bash
npm run watch    # Watch mode (JS + CSS)
npm run build    # Production build
npm test         # Run tests
```

## Tech Stack

- **Build**: esbuild
- **UI**: Tailwind CSS + DaisyUI
- **Templates**: Mustache
- **LLM**: OpenRouter (Gemini, Llama, Qwen with cascading fallback)
