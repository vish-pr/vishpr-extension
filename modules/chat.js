// Chat Functionality
import { elements } from './dom.js';
import { marked } from 'marked';
import { getEndpoints } from './llm/index.js';
import DOMPurify from 'dompurify';

// Message history for up/down arrow navigation
const messageHistory = [];
let historyIndex = -1;
let currentDraft = '';

function getStatusContainer() {
  let container = elements.chatContainer.querySelector('.status-whisper-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'status-whisper-container';
    elements.chatContainer.prepend(container);
  }
  return container;
}

function clearEmptyState() {
  const emptyState = elements.chatContainer.querySelector('.empty-state');
  if (emptyState) {
    emptyState.remove();
  }
}

async function setStatus(text, isProcessing = false) {
  const statusDot = document.getElementById('statusDot');
  const statusText = document.getElementById('statusText');
  if (statusText) {
    statusText.textContent = text;
  }
  if (statusDot) {
    if (isProcessing) {
      // While processing, show active (animated) state
      statusDot.classList.add('active');
    } else {
      // When idle, show green only if endpoints are configured
      const endpoints = await getEndpoints();
      statusDot.classList.toggle('active', Object.keys(endpoints).length > 0);
    }
  }
}

export function addMessage(role, content, { timeout = null } = {}) {
  clearEmptyState();

  if (role === 'system') {
    // Determine status type
    const isError = content.startsWith('✗') || content.toLowerCase().includes('error') || content.toLowerCase().includes('failed');
    const isSuccess = content.startsWith('✓');
    const type = isError ? 'error' : isSuccess ? 'success' : 'info';

    // Clean content
    const cleanContent = content.replace(/^[✓✗]\s*/, '');

    const whisper = document.createElement('div');
    whisper.className = `status-whisper ${type}`;

    const dismissTime = timeout ?? 20000;
    whisper.style.setProperty('--duration', `${dismissTime}ms`);

    whisper.innerHTML = `<span class="status-dot-indicator"></span><span class="status-text">${cleanContent}</span>`;

    const container = getStatusContainer();
    container.appendChild(whisper);

    // Auto-dismiss
    if (dismissTime > 0) {
      setTimeout(() => {
        whisper.classList.add('dismissing');
        whisper.addEventListener('animationend', () => whisper.remove());
      }, dismissTime);
    }

    return whisper;
  }

  const messageDiv = document.createElement('div');
  const isUser = role === 'user';
  const isError = role === 'error';
  messageDiv.className = `chat ${isUser ? 'chat-end' : 'chat-start'} message`;

  const bubbleDiv = document.createElement('div');
  if (isError) {
    bubbleDiv.className = 'chat-bubble chat-bubble-error text-sm';
    const errorSpan = document.createElement('span');
    errorSpan.className = 'error-content';
    errorSpan.textContent = content;
    bubbleDiv.appendChild(errorSpan);
  } else {
    bubbleDiv.className = `chat-bubble ${isUser ? 'chat-bubble-primary' : ''} text-sm`;
    bubbleDiv.innerHTML = DOMPurify.sanitize(marked.parse(content, { breaks: true }));
  }
  messageDiv.appendChild(bubbleDiv);

  elements.chatContainer.appendChild(messageDiv);
  elements.chatContainer.scrollTop = elements.chatContainer.scrollHeight;

  return messageDiv;
}

function addTypingIndicator() {
  clearEmptyState();

  const messageDiv = document.createElement('div');
  messageDiv.className = 'chat chat-start message';
  messageDiv.id = 'typing-indicator';

  const bubbleDiv = document.createElement('div');
  bubbleDiv.className = 'chat-bubble';
  bubbleDiv.innerHTML = '<span class="loading loading-dots loading-sm"></span>';

  messageDiv.appendChild(bubbleDiv);
  elements.chatContainer.appendChild(messageDiv);
  elements.chatContainer.scrollTop = elements.chatContainer.scrollHeight;
}

function removeTypingIndicator() {
  const indicator = document.getElementById('typing-indicator');
  if (indicator) {
    indicator.remove();
  }
}

async function sendMessageToBackground(message) {
  return chrome.runtime.sendMessage({
    action: 'processMessage',
    message
  });
}

async function sendMessage() {
  const message = elements.messageInput.value.trim();
  if (!message) return;

  // Add to history (avoid duplicates of last message)
  if (messageHistory[messageHistory.length - 1] !== message) {
    messageHistory.push(message);
  }
  historyIndex = -1;
  currentDraft = '';

  addMessage('user', message);
  elements.messageInput.value = '';
  elements.messageInput.style.height = 'auto';
  elements.sendButton.disabled = true;

  await setStatus('Processing', true);
  addTypingIndicator();

  try {
    const response = await sendMessageToBackground(message);
    removeTypingIndicator();

    if (response.error) {
      addMessage('error', response.error);
    } else {
      addMessage('assistant', response.result);
    }
  } catch (error) {
    removeTypingIndicator();
    addMessage('error', error.message);
  } finally {
    elements.sendButton.disabled = false;
    await setStatus('Ready', false);
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
      return;
    }

    // History navigation with up/down arrows
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      const input = elements.messageInput;
      const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
      const atEnd = input.selectionStart === input.value.length;
      const isEmpty = input.value === '';

      // Only navigate history when input is empty or cursor is at boundaries
      if (e.key === 'ArrowUp' && (isEmpty || atStart)) {
        if (messageHistory.length === 0) return;
        e.preventDefault();

        // Save current input as draft when starting to navigate
        if (historyIndex === -1) {
          currentDraft = input.value;
        }

        // Move back in history
        if (historyIndex < messageHistory.length - 1) {
          historyIndex++;
          input.value = messageHistory[messageHistory.length - 1 - historyIndex];
          input.setSelectionRange(input.value.length, input.value.length);
        }
      } else if (e.key === 'ArrowDown' && (isEmpty || atEnd)) {
        if (historyIndex === -1) return;
        e.preventDefault();

        // Move forward in history
        historyIndex--;
        if (historyIndex === -1) {
          // Restore draft
          input.value = currentDraft;
        } else {
          input.value = messageHistory[messageHistory.length - 1 - historyIndex];
        }
        input.setSelectionRange(input.value.length, input.value.length);
      }
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

  // Set initial status
  if (hasValidKey) {
    setStatus('Ready', false);
  } else {
    setStatus('No API Key', false);
  }
}
