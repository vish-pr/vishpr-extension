# Privacy Policy for Vishpr Browser Agent

**Last Updated:** January 2026

## Overview

Vishpr Browser Agent ("the Extension") is a browser extension that uses Large Language Models (LLMs) to automate web browsing tasks through natural language commands. This privacy policy explains how we handle your data.

## Data Collection and Usage

### What We Collect

The Extension collects and processes the following data locally on your device:

1. **User Commands**: Natural language instructions you provide to automate browsing tasks
2. **Page Content**: Text content from web pages you interact with (used to execute your commands)
3. **API Keys**: Your OpenRouter API key (stored locally in Chrome storage)
4. **Chat History**: Conversation history with the Extension (stored locally)
5. **Settings**: Your preferences and configuration options (stored locally)

### What We Send to Third Parties

To process your commands, the Extension sends data to **OpenRouter** (https://openrouter.ai):

- Your natural language commands
- Relevant page content needed to execute commands
- This data is sent using your personal OpenRouter API key

**We do not operate any servers. All data processing happens locally or through your direct connection to OpenRouter.**

### What We Do NOT Collect

- Personal identification information
- Browsing history beyond the current session
- Passwords or sensitive form data
- Payment information
- Location data

## Data Storage

All data is stored locally on your device using Chrome's built-in storage API:

- **API Keys**: Stored securely in Chrome's local storage
- **Settings**: Stored in Chrome's sync storage (synced across your devices if signed into Chrome)
- **Chat History**: Stored temporarily in session storage

## Third-Party Services

### OpenRouter

The Extension uses OpenRouter as an intermediary to access various LLM providers. When you use the Extension:

- Your commands and relevant page content are sent to OpenRouter
- OpenRouter's privacy policy applies: https://openrouter.ai/privacy
- You must provide your own API key; we never have access to it

## Permissions Explained

The Extension requires these permissions:

| Permission | Purpose |
|------------|---------|
| `sidePanel` | Display the chat interface in Chrome's side panel |
| `tabs` | Access tab information to execute navigation commands |
| `activeTab` | Read content from the current page to understand context |
| `scripting` | Execute actions on web pages (clicking, typing, etc.) |
| `storage` | Save your settings and API key locally |
| `<all_urls>` | Work on any website you choose to automate |

## Data Security

- All data transmission to OpenRouter uses HTTPS encryption
- Your API key is stored locally and never transmitted to us
- No data is stored on external servers controlled by us

## Your Rights

You can:

- **Delete your data**: Clear Chrome's extension storage to remove all local data
- **Revoke access**: Disable or uninstall the Extension at any time
- **Control API access**: Revoke your OpenRouter API key to stop LLM processing

## Children's Privacy

This Extension is not intended for use by children under 13. We do not knowingly collect data from children.

## Changes to This Policy

We may update this privacy policy. Changes will be reflected in the "Last Updated" date above.

## Contact

For questions about this privacy policy or the Extension:

- GitHub Issues: https://github.com/anthropics/vishpr/issues

## Consent

By using Vishpr Browser Agent, you consent to this privacy policy.
