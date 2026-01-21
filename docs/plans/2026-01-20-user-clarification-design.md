# User Clarification System Design

## Overview

A system for handling situations where the LLM needs user clarification. Uses a parallel approach: shows questions to the user while simultaneously preparing guessed answers as timeout defaults.

## Architecture

```
LLM Response ──► QUESTION_DETECTOR (post-filter)
                        │
                        ▼
                 Contains questions?
                  /            \
                No              Yes
                │                │
                ▼                ▼
            Continue      USER_CLARIFICATION
                                │
                        ┌───────┴───────┐
                        │   Parallel    │
                        ▼               ▼
                  ANSWER_GUESSER    Show UI
                  (ranks options)   (overlay)
                        │               │
                        └───────┬───────┘
                                ▼
                        User responds OR timeout
                                │
                                ▼
                        Return { type: 'user_clarification',
                                 response, timed_out }
```

## Actions

### 1. QUESTION_DETECTOR

Analyzes LLM output and extracts questions with possible answers.

**Input:** Raw LLM response text
**Output:** Detected questions with generated options and complexity rating

**Complexity → Timeout mapping:**
- `low`: 8 seconds (yes/no, simple choice)
- `medium`: 15 seconds (3-4 domain options)
- `high`: 25 seconds (open-ended or technical)

### 2. ANSWER_GUESSER

Ranks options by confidence using conversation context and page content.

**Input:** Question, options, conversation context, page content
**Output:** Top 2-3 options ordered by confidence with reasoning

**Context analyzed:**
- Conversation history for user intent signals
- Current page content/browser state
- Implicit preferences in user phrasing

### 3. USER_CLARIFICATION

Orchestrates the parallel flow and returns special type for UI.

**Input:** Questions with options, context
**Output:** Special return type that executor recognizes

```typescript
interface ClarificationResult {
  type: 'user_clarification';
  questions: Array<{
    question: string;
    options: Array<{ label: string; value: string; confidence?: number; reasoning?: string }>;
    complexity: 'low' | 'medium' | 'high';
    timeout_ms: number;
  }>;
  default_answers: string[];
  ui_config: {
    pause_on_focus: true;
    idle_resume_ms: 5000;
    show_confidence_hints: boolean;
  };
}
```

## UI Overlay Behavior

**Structure:**
- Question text at top
- Clickable option buttons ordered by confidence
- Confidence hints shown as percentage or reasoning tooltip
- Countdown progress bar
- Chat input remains visible for custom responses

**Behaviors:**
- Click option → Immediately submit, close overlay
- Type in chat → Pause timer, overlay dims slightly
- 5s idle in chat → Resume timer, overlay brightens
- Timeout → Flash top option briefly (500ms), then auto-submit
- Multiple questions → Show one at a time with progress indicator

## Integration

**Router integration:** Add `USER_CLARIFICATION` to available actions in router-action.ts

**Executor changes:** Detect `type: 'user_clarification'` in step result and trigger UI

## Files

**New:**
- `modules/actions/question-detector-action.ts`
- `modules/actions/answer-guesser-action.ts`
- `modules/actions/user-clarification-action.ts`

**Modified:**
- `modules/actions/index.ts`
- `modules/actions/router-action.ts`
