// Chat Functionality
import { elements } from './dom.js';
import { logAction } from './storage.js';

export function addMessage(role, content) {
  const messageDiv = document.createElement('div');
  messageDiv.className = `message ${role}`;
  messageDiv.textContent = content;
  elements.chatContainer.appendChild(messageDiv);
  elements.chatContainer.scrollTop = elements.chatContainer.scrollHeight;
}

async function sendMessageToBackground(message) {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  return chrome.runtime.sendMessage({
    action: 'processMessage',
    message,
    tabId: tab.id,
    tabUrl: tab.url
  });
}

async function sendMessage() {
  const message = elements.messageInput.value.trim();
  if (!message) return;

  addMessage('user', message);
  elements.messageInput.value = '';
  elements.messageInput.style.height = 'auto';
  elements.sendButton.disabled = true;

  await logAction('message', `Sent: ${message.substring(0, 50)}${message.length > 50 ? '...' : ''}`);

  try {
    const response = await sendMessageToBackground(message);

    if (response.error) {
      addMessage('system', `Error: ${response.error}`);
    } else {
      addMessage('assistant', response.result);
    }
  } catch (error) {
    addMessage('system', `Error: ${error.message}`);
  } finally {
    elements.sendButton.disabled = false;
  }
}

function setupAutoResize() {
  elements.messageInput.addEventListener('input', () => {
    elements.messageInput.style.height = 'auto';
    elements.messageInput.style.height = elements.messageInput.scrollHeight + 'px';
  });
}

function setupKeyboardShortcuts() {
  elements.messageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
}

function setupMessageListener() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.action === 'addMessage') {
      addMessage(message.role, message.content);
    }
  });
}

export function initChat(hasValidKey) {
  setupAutoResize();
  setupKeyboardShortcuts();
  setupMessageListener();
  elements.sendButton.addEventListener('click', sendMessage);

  const welcomeMessage = hasValidKey
    ? 'Ready. I can help you read pages, click elements, and navigate the web.'
    : 'Please configure an API key (Gemini or OpenRouter) in settings to get started.';

  addMessage('system', welcomeMessage);
}
