/**
 * Clarification UI - Industrial minimal design
 * Shows question immediately with input, loads options with shimmer effect
 */

import { elements } from './dom.js';
import logger from './logger.js';

const IDLE_RESUME_MS = 5000;
const WARNING_THRESHOLD = 0.4;
const CRITICAL_THRESHOLD = 0.2;

class ClarificationUI {
  constructor() {
    this.overlay = null;
    this.panel = null;
    this.timerBar = null;
    this.timerSeconds = null;
    this.optionsContainer = null;
    this.optionsHeader = null;
    this.questionText = null;
    this.questionContext = null;
    this.hintContainer = null;
    this.hintText = null;
    this.progressContainer = null;
    this.pausedIndicator = null;
    this.customInput = null;
    this.optionTemplate = null;

    this.currentConfig = null;
    this.currentQuestionIndex = 0;
    this.intervalId = null;
    this.idleTimeoutId = null;
    this.animationTimeoutId = null;
    this.remainingMs = 0;
    this.totalMs = 0;
    this.isPaused = false;
    this.optionsLoaded = false;
    this.resolvePromise = null;
    this.responses = [];
    this.initialized = false;

    this.boundHandleInputKeydown = this.handleInputKeydown.bind(this);
    this.boundHandleInputFocus = this.handleInputFocus.bind(this);
    this.boundHandleInputBlur = this.handleInputBlur.bind(this);
  }

  init() {
    if (this.initialized) return true;
    if (typeof document === 'undefined') {
      logger.debug('Clarification UI: no document available');
      return false;
    }

    this.overlay = elements.clarificationOverlay;
    if (!this.overlay) {
      logger.debug('Clarification overlay element not found');
      return false;
    }

    this.panel = this.overlay.querySelector('.clarification-panel');
    const q = (sel) => this.overlay.querySelector(sel);

    this.timerBar = q('.lifeline-fill');
    this.timerSeconds = q('.timer-seconds');
    this.optionsContainer = q('.clarification-options');
    this.optionsStatus = q('.options-status');
    this.optionsLoading = q('.options-loading');
    this.optionsLabel = q('.options-label');
    this.questionText = q('.question-text');
    this.questionContext = q('.question-context');
    this.hintContainer = q('.clarification-hint');
    this.hintText = q('.hint-text');
    this.progressContainer = q('.clarification-progress');
    this.pausedIndicator = q('.clarification-paused');
    this.customInput = q('.clarification-input');
    this.optionTemplate = elements.tplClarificationOption;

    // Backdrop click = select default
    q('.modal-backdrop')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.selectOption(this.getDefaultValue(), true);
    });

    this.initialized = true;
    return true;
  }

  getDefaultValue(index = this.currentQuestionIndex) {
    const config = this.currentConfig;
    return config?.default_answers?.[index] || config?.questions?.[index]?.options?.[0]?.value || '';
  }

  /**
   * Show question immediately with loading state
   * Called by executor before action runs
   */
  showWithLoading(questions) {
    if (!this.init()) {
      logger.debug('Clarification UI: no DOM for loading state');
      return;
    }

    // Create minimal config for loading state
    this.currentConfig = {
      questions: questions.map(q => ({
        question: q.question,
        complexity: q.complexity,
        options: [],
        timeout_ms: { low: 8000, medium: 15000, high: 25000 }[q.complexity] || 15000
      })),
      default_answers: [],
      ui_config: {
        pause_on_focus: true,
        idle_resume_ms: 5000,
        show_confidence_hints: false
      }
    };

    this.currentQuestionIndex = 0;
    this.responses = [];
    this.optionsLoaded = false;

    this.showQuestion(0, true);
    this.overlay.showModal();
    this.attachInputListeners();
  }

  /**
   * Update with full config including generated options
   * Called by executor when action completes
   */
  updateWithOptions(config) {
    if (!this.initialized || !this.currentConfig) return;

    this.currentConfig = config;
    this.optionsLoaded = true;

    // Update current question with options
    const question = config.questions?.[this.currentQuestionIndex];
    if (question) {
      this.renderOptions(question.options, config.ui_config?.show_confidence_hints);

      // Show hint if available
      const topOption = question.options[0];
      if (topOption?.reasoning && config.ui_config?.show_confidence_hints && this.hintContainer) {
        this.hintText.textContent = topOption.reasoning;
        this.hintContainer.classList.remove('hidden');
      }

      // Start timer now that options are ready
      this.startTimer(question.timeout_ms);
    }
  }

  /**
   * Standard show - used when config has options already
   */
  show(config) {
    if (!this.init()) {
      logger.debug('Clarification UI: returning defaults (no DOM)');
      return Promise.resolve(
        (config.default_answers || []).map((value, i) => ({ value, timed_out: true, question_index: i }))
      );
    }

    this.currentConfig = config;
    this.currentQuestionIndex = 0;
    this.responses = [];
    this.optionsLoaded = true;

    return new Promise((resolve) => {
      this.resolvePromise = resolve;
      this.showQuestion(0, false);
      this.overlay.showModal();
      this.attachInputListeners();
    });
  }

  /**
   * Get promise for user response (used with showWithLoading)
   */
  getResponsePromise() {
    return new Promise((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  hide() {
    if (!this.initialized) return;
    this.stopTimer();
    this.detachInputListeners();
    this.overlay?.close();

    if (this.resolvePromise) {
      const total = this.currentConfig?.questions?.length || 0;
      for (let i = this.responses.length; i < total; i++) {
        this.responses.push({ value: this.getDefaultValue(i), timed_out: true, question_index: i });
      }
      this.resolvePromise(this.responses);
      this.resolvePromise = null;
    }

    this.currentConfig = null;
    this.optionsLoaded = false;
  }

  showQuestion(index, loading = false) {
    const question = this.currentConfig?.questions?.[index];
    if (!question) {
      this.hide();
      return;
    }

    this.currentQuestionIndex = index;
    this.questionText.textContent = question.question;
    this.questionContext.textContent = '';

    // Reset input
    if (this.customInput) {
      this.customInput.value = '';
    }

    // Reset panel urgency
    this.panel?.removeAttribute('data-urgency');

    // Hide hint initially
    this.hintContainer?.classList.add('hidden');

    if (loading) {
      // Show loading state
      this.optionsContainer.classList.remove('loaded');
      this.optionsLoading?.classList.remove('hidden');
      this.optionsLabel?.classList.add('hidden');

      // Reset to skeleton state
      this.optionsContainer.innerHTML = `
        <div class="option-skeleton skeleton"></div>
        <div class="option-skeleton skeleton"></div>
        <div class="option-skeleton skeleton"></div>
      `;

      // Don't start timer yet - wait for options
      if (this.timerBar) this.timerBar.style.width = '100%';
      this.timerSeconds.textContent = Math.ceil(question.timeout_ms / 1000);
    } else {
      const showHints = this.currentConfig.ui_config?.show_confidence_hints;
      this.renderOptions(question.options, showHints);

      const topOption = question.options[0];
      if (topOption?.reasoning && showHints && this.hintContainer) {
        this.hintText.textContent = topOption.reasoning;
        this.hintContainer.classList.remove('hidden');
      }

      this.startTimer(question.timeout_ms);
    }

    this.renderProgressDots();
  }

  renderOptions(options, showConfidence) {
    // Mark as loaded
    this.optionsContainer.classList.add('loaded');
    this.optionsLoading?.classList.add('hidden');
    this.optionsLabel?.classList.remove('hidden');

    // Clear all existing content (skeletons and previous options)
    this.optionsContainer.innerHTML = '';

    // Render exactly 3 options (pad if needed, truncate if more)
    const normalizedOptions = options.slice(0, 3);
    while (normalizedOptions.length < 3) {
      normalizedOptions.push({
        label: '—',
        value: `skip_${normalizedOptions.length}`,
        confidence: 0
      });
    }

    normalizedOptions.forEach((option, idx) => {
      const el = this.optionTemplate.content.cloneNode(true);
      const btn = el.querySelector('.clarification-option');

      btn.querySelector('.option-rank').textContent = idx + 1;
      btn.querySelector('.option-label').textContent = option.label;

      if (idx === 0) {
        btn.classList.add('recommended');
      }

      const confidenceProgress = btn.querySelector('.option-confidence');
      if (showConfidence && option.confidence != null && confidenceProgress) {
        confidenceProgress.value = option.confidence;
      } else {
        confidenceProgress?.remove();
      }

      btn.addEventListener('click', () => this.selectOption(option.value, false));
      this.optionsContainer.appendChild(el);
    });
  }

  renderProgressDots() {
    const total = this.currentConfig?.questions?.length || 0;
    if (total <= 1) {
      this.progressContainer.innerHTML = '';
      return;
    }

    this.progressContainer.innerHTML = Array.from({ length: total }, (_, i) => {
      const cls = i < this.currentQuestionIndex ? 'completed' : i === this.currentQuestionIndex ? 'active' : '';
      return `<span class="dot ${cls}"></span>`;
    }).join('');
  }

  startTimer(durationMs) {
    this.stopTimer();
    this.remainingMs = durationMs;
    this.totalMs = durationMs;
    this.isPaused = false;
    this.updateTimerDisplay();

    this.intervalId = setInterval(() => {
      if (this.isPaused) return;
      this.remainingMs -= 100;
      this.updateTimerDisplay();
      if (this.remainingMs <= 0) this.onTimeout();
    }, 100);
  }

  stopTimer() {
    if (this.intervalId) { clearInterval(this.intervalId); this.intervalId = null; }
    if (this.idleTimeoutId) { clearTimeout(this.idleTimeoutId); this.idleTimeoutId = null; }
    if (this.animationTimeoutId) { clearTimeout(this.animationTimeoutId); this.animationTimeoutId = null; }
  }

  updateTimerDisplay() {
    const progress = this.remainingMs / this.totalMs;
    const seconds = Math.ceil(this.remainingMs / 1000);

    if (this.timerSeconds) this.timerSeconds.textContent = seconds;
    if (this.timerBar) this.timerBar.style.width = `${progress * 100}%`;

    // Update urgency state
    if (this.panel) {
      if (progress <= CRITICAL_THRESHOLD) {
        this.panel.setAttribute('data-urgency', 'critical');
      } else if (progress <= WARNING_THRESHOLD) {
        this.panel.setAttribute('data-urgency', 'warning');
      } else {
        this.panel.removeAttribute('data-urgency');
      }
    }
  }

  onTimeout() {
    this.stopTimer();
    const defaultValue = this.getDefaultValue();
    const recommendedBtn = this.optionsContainer.querySelector('.clarification-option.recommended');

    if (recommendedBtn) {
      recommendedBtn.classList.add('selected');
      this.animationTimeoutId = setTimeout(() => this.selectOption(defaultValue, true), 400);
    } else {
      this.selectOption(defaultValue, true);
    }
  }

  selectOption(value, timedOut) {
    this.stopTimer();
    this.responses.push({ value, timed_out: timedOut, question_index: this.currentQuestionIndex });

    const nextIndex = this.currentQuestionIndex + 1;
    if (nextIndex < (this.currentConfig?.questions?.length || 0)) {
      // For multiple questions, show next with loading if options not ready
      const hasOptions = this.currentConfig.questions[nextIndex]?.options?.length > 0;
      this.showQuestion(nextIndex, !hasOptions);
    } else {
      this.hide();
    }
  }

  pauseTimer() {
    if (this.isPaused) return;
    this.isPaused = true;
    this.pausedIndicator?.classList.remove('hidden');
    logger.debug('Clarification timer paused');
  }

  resumeTimer() {
    if (!this.isPaused) return;
    this.isPaused = false;
    this.pausedIndicator?.classList.add('hidden');
    logger.debug('Clarification timer resumed');
  }

  handleInputFocus() {
    if (!this.currentConfig?.ui_config?.pause_on_focus) return;
    if (this.idleTimeoutId) { clearTimeout(this.idleTimeoutId); this.idleTimeoutId = null; }
    this.pauseTimer();
  }

  handleInputBlur() {
    if (!this.isPaused) return;
    const idleMs = this.currentConfig?.ui_config?.idle_resume_ms || IDLE_RESUME_MS;
    this.idleTimeoutId = setTimeout(() => this.resumeTimer(), idleMs);
  }

  handleInputKeydown(e) {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const customValue = this.customInput?.value?.trim();
    if (!customValue) return;
    e.preventDefault();
    this.customInput.value = '';
    this.selectOption(customValue, false);
  }

  attachInputListeners() {
    if (this.customInput) {
      this.customInput.addEventListener('focus', this.boundHandleInputFocus);
      this.customInput.addEventListener('blur', this.boundHandleInputBlur);
      this.customInput.addEventListener('keydown', this.boundHandleInputKeydown);
    }

    // Also listen on main message input
    const mainInput = elements.messageInput;
    if (mainInput) {
      mainInput.addEventListener('focus', this.boundHandleInputFocus);
      mainInput.addEventListener('blur', this.boundHandleInputBlur);
    }
  }

  detachInputListeners() {
    if (this.customInput) {
      this.customInput.removeEventListener('focus', this.boundHandleInputFocus);
      this.customInput.removeEventListener('blur', this.boundHandleInputBlur);
      this.customInput.removeEventListener('keydown', this.boundHandleInputKeydown);
    }

    const mainInput = elements.messageInput;
    if (mainInput) {
      mainInput.removeEventListener('focus', this.boundHandleInputFocus);
      mainInput.removeEventListener('blur', this.boundHandleInputBlur);
    }
  }
}

export const clarificationUI = new ClarificationUI();
export const showClarification = (config) => clarificationUI.show(config);
export const showClarificationLoading = (questions) => clarificationUI.showWithLoading(questions);
export const updateClarificationOptions = (config) => clarificationUI.updateWithOptions(config);
export const getClarificationResponse = () => clarificationUI.getResponsePromise();
export const hideClarification = () => clarificationUI.hide();
export default clarificationUI;
