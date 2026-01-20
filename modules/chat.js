// Chat Functionality
import { elements } from './dom.js';
import { marked } from 'marked';
import { getEndpoints } from './llm/index.js';
import DOMPurify from 'dompurify';

const messageHistory = [];
let historyIndex = -1;
let currentDraft = '';
let chatStatus = { text: 'Ready', dotActive: false };

function getStatusContainer() {
  return elements.chatContainer.querySelector('.status-whisper-container')
    ?? elements.chatContainer.insertBefore(
      Object.assign(document.createElement('div'), { className: 'status-whisper-container' }),
      elements.chatContainer.firstChild
    );
}

function clearEmptyState() {
  elements.chatContainer.querySelector('.empty-state')?.remove();
}

async function setStatus(text, isProcessing = false) {
  const dotActive = isProcessing || Object.keys(await getEndpoints()).length > 0;
  chatStatus = { text, dotActive };

  if (document.getElementById('debugContainer')?.classList.contains('hidden') !== false) {
    const statusText = document.getElementById('statusText');
    if (statusText) statusText.textContent = text;
    document.getElementById('statusDot')?.classList.toggle('active', dotActive);
  }
}

export function getChatStatus() {
  return chatStatus;
}

export function addMessage(role, content, { timeout = null } = {}) {
  clearEmptyState();

  if (role === 'system') {
    const isError = content.startsWith('✗') || /error|failed/i.test(content);
    const type = isError ? 'error' : content.startsWith('✓') ? 'success' : 'info';
    const dismissTime = timeout ?? 20000;

    const whisper = Object.assign(document.createElement('div'), {
      className: `status-whisper ${type}`,
      innerHTML: `<span class="status-dot-indicator"></span><span class="status-text">${content.replace(/^[✓✗]\s*/, '')}</span>`
    });
    whisper.style.setProperty('--duration', `${dismissTime}ms`);
    getStatusContainer().appendChild(whisper);

    if (dismissTime > 0) {
      setTimeout(() => {
        whisper.classList.add('dismissing');
        whisper.addEventListener('animationend', () => whisper.remove());
      }, dismissTime);
    }
    return whisper;
  }

  const isUser = role === 'user';
  const isError = role === 'error';
  const messageDiv = Object.assign(document.createElement('div'), {
    className: `chat ${isUser ? 'chat-end' : 'chat-start'} message`
  });

  const bubbleDiv = document.createElement('div');
  bubbleDiv.className = `chat-bubble ${isError ? 'chat-bubble-error' : isUser ? 'chat-bubble-primary' : ''} text-sm`;
  if (isError) {
    bubbleDiv.innerHTML = `<span class="error-content">${content}</span>`;
  } else {
    bubbleDiv.innerHTML = DOMPurify.sanitize(marked.parse(content, { breaks: true }));
  }
  messageDiv.appendChild(bubbleDiv);

  elements.chatContainer.appendChild(messageDiv);
  elements.chatContainer.scrollTop = elements.chatContainer.scrollHeight;
  return messageDiv;
}

function addTypingIndicator() {
  clearEmptyState();
  const messageDiv = Object.assign(document.createElement('div'), {
    className: 'chat chat-start message',
    id: 'typing-indicator',
    innerHTML: '<div class="chat-bubble"><span class="loading loading-dots loading-sm"></span></div>'
  });
  elements.chatContainer.appendChild(messageDiv);
  elements.chatContainer.scrollTop = elements.chatContainer.scrollHeight;
}

function removeTypingIndicator() {
  document.getElementById('typing-indicator')?.remove();
}

async function sendMessageToBackground(message) {
  return chrome.runtime.sendMessage({ action: 'processMessage', message });
}

async function sendMessage() {
  const message = elements.messageInput.value.trim();
  if (!message) return;

  if (messageHistory[messageHistory.length - 1] !== message) messageHistory.push(message);
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
    addMessage(response.error ? 'error' : 'assistant', response.error || response.result);
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
      return sendMessage();
    }

    const input = elements.messageInput;
    const { selectionStart, selectionEnd, value } = input;
    const atStart = selectionStart === 0 && selectionEnd === 0;
    const atEnd = selectionStart === value.length;

    if (e.key === 'ArrowUp' && (value === '' || atStart) && messageHistory.length) {
      e.preventDefault();
      if (historyIndex === -1) currentDraft = value;
      if (historyIndex < messageHistory.length - 1) {
        input.value = messageHistory[messageHistory.length - 1 - ++historyIndex];
        input.setSelectionRange(input.value.length, input.value.length);
      }
    } else if (e.key === 'ArrowDown' && (value === '' || atEnd) && historyIndex !== -1) {
      e.preventDefault();
      input.value = --historyIndex === -1 ? currentDraft : messageHistory[messageHistory.length - 1 - historyIndex];
      input.setSelectionRange(input.value.length, input.value.length);
    }
  });
}

function setupMessageListener() {
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.action === 'addMessage') addMessage(msg.role, msg.content);
  });
}

export function initChat(hasValidKey) {
  setupAutoResize();
  setupKeyboardShortcuts();
  setupMessageListener();
  elements.sendButton.addEventListener('click', sendMessage);
  setStatus(hasValidKey ? 'Ready' : 'No API Key', false);
}
