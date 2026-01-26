# Vishpr Browser Agent

A Chrome extension that automates web browsing through natural language commands. Tell Vishpr what to do in plain English, and watch it click, fill forms, navigate, and extract information for you.

## Features

- **Natural Language Control** - Type commands like "fill out this contact form" or "click the submit button"
- **Page Interaction** - Click buttons, links, fill forms, scroll, and navigate
- **Information Extraction** - Read page content, find elements, and summarize text
- **Multi-Step Tasks** - Chain multiple actions together for complex workflows
- **Smart Clarification** - Asks for missing information when commands are ambiguous
- **LLM Provider Choice** - Works with OpenRouter, Cerebras, Mistral, or any OpenAI-compatible API

## Installation

### From Releases

1. Download the latest ZIP from [Releases](https://github.com/vish-pr/vishpr-extension/releases)
2. Extract the ZIP file
3. Load in Chrome:
   - Go to `chrome://extensions`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the extracted folder

### From Source

1. Clone the repository:
   ```bash
   git clone https://github.com/vish-pr/vishpr-extension.git
   cd vishpr-extension
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Build the extension:
   ```bash
   npm run build
   ```

4. Load in Chrome:
   - Go to `chrome://extensions`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the `dist` folder

## Usage

1. Click the Vishpr icon or press `Ctrl+Shift+Y` to open the side panel
2. Enter your API key in Settings (OpenRouter, Cerebras, or custom endpoint)
3. Type what you want to do:
   - "Play music"
   - "Fill out this form with name John Doe and email john@example.com"
   - "Scroll down and find the pricing section"
   - "Read the main article and summarize it"

## Development

### Commands

```bash
npm run build      # Production build and test
npm run package    # Build and create release ZIP
npm run typecheck  # TypeScript type checking
```

### Project Structure

```
├── manifest.json        # Chrome extension manifest (v3)
├── background.js        # Service worker
├── content.js           # Content script (runs on pages)
├── sidepanel.html       # Side panel UI
├── sidepanel.js         # Side panel initialization
├── modules/
│   ├── actions/         # Action definitions (browser, router, LLM)
│   ├── llm/             # LLM integration with model cascading
│   ├── debug/           # Trace collector and stats
│   ├── executor.js      # Action execution engine
│   ├── chat.js          # Chat UI logic
│   └── settings.js      # Configuration management
├── dist/                # Build output
└── release/             # Packaged releases
```

### Architecture

The extension uses an action-based architecture:

1. **Router** - Receives user input and routes to appropriate action
2. **Browser Actions** - READ_PAGE, CLICK_ELEMENT, FILL_FORM, SCROLL_AND_WAIT
3. **LLM Tool** - Handles general knowledge queries
4. **Execution Loop** - Multi-turn conversation until task completion

## Configuration

### Supported LLM Providers

- **OpenRouter** (default) - Access to multiple models
- **Cerebras** - Fast inference
- **Mistral** - European provider
- **Custom** - Any OpenAI-compatible endpoint

### Model Tiers

Configure models for different intelligence levels:
- **High** - Complex reasoning tasks
- **Medium** - Standard operations
- **Low** - Simple queries

## Privacy

- All data stays on your device
- API keys stored locally in Chrome storage
- Your data is only sent to the LLM provider you choose, with your API keys directly
- No tracking or analytics send to anyone other than the LLM provider you choose
- Option to use local LLMs
- Open source

## Tech Stack

- TypeScript / ES Modules
- Tailwind CSS + DaisyUI
- esbuild bundler
- Chrome Extension Manifest V3

## License

CC-BY-NC-4.0 (Creative Commons Attribution-NonCommercial 4.0)
