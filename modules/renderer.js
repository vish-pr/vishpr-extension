// UI Rendering Functions
import { formatTimestamp } from './utils.js';

export function renderExtractionItem(extraction) {
  const { text = '', links = [], buttons = [] } = extraction;

  return `
    <div class="extraction-item" data-url="${extraction.url}" data-timestamp="${extraction.timestamp}">
      <div class="extraction-item-header">
        <div class="extraction-item-title">${extraction.title || 'Untitled'}</div>
        <div class="extraction-item-time">${formatTimestamp(extraction.timestamp)}</div>
      </div>
      <div class="extraction-item-url">${extraction.url}</div>
      <div class="extraction-item-stats">
        <span>${text.length} chars</span>
        <span>${links.length} links</span>
        <span>${buttons.length} buttons</span>
      </div>
    </div>
  `;
}

function renderSection(label, content) {
  return `
    <div class="extraction-detail-section">
      <div class="extraction-detail-label">${label}</div>
      <div class="extraction-detail-content">${content}</div>
    </div>
  `;
}

export function renderExtractionDetail(extraction) {
  const text = extraction.text?.substring(0, 1000) || 'No text content';
  const links = extraction.links?.slice(0, 10) || [];
  const buttons = extraction.buttons?.slice(0, 10) || [];

  const sections = [
    renderSection('Text Content (first 1000 chars)', text),
    links.length > 0 ? renderSection(
      'Links (first 10)',
      links.map(l => `${l.text || 'No text'}: ${l.href}`).join('\n')
    ) : '',
    buttons.length > 0 ? renderSection(
      'Buttons (first 10)',
      buttons.map(b => `${b.text || 'No text'} (${b.id || b.class || 'no id/class'})`).join('\n')
    ) : ''
  ].filter(Boolean).join('');

  return `
    <div class="extraction-detail">
      <div class="extraction-detail-header">
        <div class="extraction-detail-title">${extraction.title || 'Untitled'}</div>
        <div class="extraction-detail-url">${extraction.url}</div>
        <div style="font-size: 11px; color: #6b7280; margin-top: 4px;">
          Extracted: ${formatTimestamp(extraction.timestamp)}
        </div>
      </div>
      ${sections}
    </div>
  `;
}

export function renderActionHistoryItem(action) {
  return `
    <div class="action-history-item">
      <div class="action-history-time">${formatTimestamp(action.timestamp)}</div>
      <div class="action-history-text">${action.description}</div>
    </div>
  `;
}

export function renderNoData(message) {
  return `<div class="no-data">${message}</div>`;
}
