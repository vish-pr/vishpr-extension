/**
 * Clarification UI - Simple modal for user input
 *
 * Flow:
 * 1. showClarificationLoading(questions) - show modal with question, no options yet
 * 2. updateClarificationOptions(config) - add options and start timer
 * 3. User clicks option OR timer expires → promise resolves
 */

import { elements } from './dom.js';

const TIMEOUT_MS = { low: 8000, medium: 15000, high: 25000 };

class ClarificationUI {
  constructor() {
    this.overlay = null;
    this.resolve = null;
    this.timerId = null;
    this.questions = null;  // [{question, complexity, options, timeout_ms}]
    this.questionIndex = 0;
    this.responses = [];    // Collected responses for each question
  }

  init() {
    if (this.overlay) return true;
    if (typeof document === 'undefined') return false;

    this.overlay = elements.clarificationOverlay;
    if (!this.overlay) return false;

    // Backdrop click = select default
    this.overlay.querySelector('.modal-backdrop')?.addEventListener('click', (e) => {
      e.preventDefault();
      const q = this.questions?.[this.questionIndex];
      if (q?.options?.length > 0) {
        this.select(q.options[0].label, true);
      }
    });

    // Custom input handlers
    const customInput = this.overlay.querySelector('.clarification-input');
    const submitBtn = this.overlay.querySelector('.clarification-submit-btn');

    submitBtn?.addEventListener('click', () => {
      const value = customInput?.value?.trim();
      if (value) {
        this.select(value, false);
        customInput.value = '';
      }
    });

    customInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const value = customInput.value?.trim();
        if (value) {
          this.select(value, false);
          customInput.value = '';
        }
      }
    });

    return true;
  }

  // Merge input questions with generated options
  mergeConfig(config) {
    const { questions = [], generated = [] } = config;
    const optionsMap = new Map(generated.map(g => [g.question_index, g.options]));

    return questions.map((q, i) => ({
      question: q.question,
      complexity: q.complexity,
      options: optionsMap.get(i) || [],
      timeout_ms: TIMEOUT_MS[q.complexity] || TIMEOUT_MS.medium
    }));
  }

  /**
   * Show modal with question only (loading state)
   */
  showLoading(questions) {
    if (!this.init()) return;

    this.questions = questions.map(q => ({
      question: q.question,
      complexity: q.complexity,
      options: [],
      timeout_ms: TIMEOUT_MS[q.complexity] || TIMEOUT_MS.medium
    }));
    this.questionIndex = 0;
    this.responses = [];

    this.renderQuestion();
    this.overlay.showModal();
  }

  /**
   * Update with generated options and start timer
   */
  updateOptions(config) {
    if (!this.overlay?.open) return;

    this.questions = this.mergeConfig(config);
    this.renderOptions();
    this.startTimer(this.questions[this.questionIndex]?.timeout_ms || 15000);
  }

  /**
   * Get promise for response (used with showLoading flow)
   */
  getPromise() {
    return new Promise(resolve => {
      this.resolve = resolve;
    });
  }

  renderQuestion() {
    const q = this.questions?.[this.questionIndex];
    if (!q) return;

    this.overlay.querySelector('.question-text').textContent = q.question;
    this.overlay.querySelector('.timer-seconds').textContent = Math.ceil(q.timeout_ms / 1000);
    this.overlay.querySelector('.lifeline-fill').style.width = '100%';

    // Show skeletons
    const container = this.overlay.querySelector('.clarification-options');
    container.innerHTML = `
      <div class="option-skeleton skeleton"></div>
      <div class="option-skeleton skeleton"></div>
      <div class="option-skeleton skeleton"></div>
    `;
  }

  renderOptions() {
    const q = this.questions?.[this.questionIndex];
    if (!q) return;

    // Update question text and timer
    this.overlay.querySelector('.question-text').textContent = q.question;
    this.overlay.querySelector('.timer-seconds').textContent = Math.ceil(q.timeout_ms / 1000);
    this.overlay.querySelector('.lifeline-fill').style.width = '100%';

    // Render options
    const container = this.overlay.querySelector('.clarification-options');
    container.innerHTML = '';

    const template = elements.tplClarificationOption;
    q.options.forEach((opt, idx) => {
      const frag = template.content.cloneNode(true);
      const btn = frag.querySelector('.clarification-option');

      btn.querySelector('.option-rank').textContent = idx + 1;
      btn.querySelector('.option-label').textContent = opt.label;
      btn.querySelector('.option-confidence')?.remove();

      if (idx === 0) btn.classList.add('recommended');

      const label = opt.label;
      btn.onclick = () => this.select(label, false);

      container.appendChild(frag);
    });
  }

  startTimer(ms) {
    this.stopTimer();

    const startTime = Date.now();
    const timerEl = this.overlay.querySelector('.timer-seconds');
    const barEl = this.overlay.querySelector('.lifeline-fill');

    this.timerId = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, ms - elapsed);
      const progress = remaining / ms;

      if (timerEl) timerEl.textContent = Math.ceil(remaining / 1000);
      if (barEl) barEl.style.width = `${progress * 100}%`;

      if (remaining <= 0) {
        const q = this.questions?.[this.questionIndex];
        this.select(q?.options[0]?.label || '', true);
      }
    }, 100);
  }

  stopTimer() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  select(value, timedOut) {
    // Guard against race condition: timer expiry + user click
    if (!this.questions || !this.overlay?.open) return;
    this.stopTimer();

    this.responses.push({ value, timed_out: timedOut, question_index: this.questionIndex });

    // More questions?
    if (this.questionIndex + 1 < this.questions.length) {
      this.questionIndex++;
      this.renderOptions();
      this.startTimer(this.questions[this.questionIndex].timeout_ms);
      return;
    }

    // Done - close and resolve
    this.overlay?.close();

    if (this.resolve) {
      this.resolve(this.responses);
      this.resolve = null;
    }

    this.questions = null;
    this.responses = [];
  }
}

// Singleton
const ui = new ClarificationUI();

// Exports
export const showClarificationLoading = (questions) => ui.showLoading(questions);
export const updateClarificationOptions = (config) => ui.updateOptions(config);
export const getClarificationResponse = () => ui.getPromise();
export const hideClarification = () => { ui.stopTimer(); ui.overlay?.close(); };
export const clarificationUI = ui;
export default ui;
