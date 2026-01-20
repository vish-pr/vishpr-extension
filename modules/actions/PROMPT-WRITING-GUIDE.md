# Practical Guide to Writing Performant AI System Prompts

A reference guide for improving existing prompts and writing new ones. Based on analysis of 30+ production system prompts from IDE coding agents, CLI assistants, autonomous engineers, UI generators, and search engines.

---

## 1. The 8 Essential Components

Every performant prompt needs these building blocks:

| Component | Purpose | When to Include |
|-----------|---------|-----------------|
| **Identity/Persona** | Establishes role and behavioral context | Always |
| **Capability Boundaries** | What AI can and cannot do | Always |
| **Tool Governance** | Rules for tool usage and sequencing | Tool-based agents |
| **Safety Constraints** | Security guardrails and refusals | Always |
| **Communication Style** | Tone, formatting, verbosity rules | Always |
| **Code Quality Standards** | Technical best practices | Coding tools |
| **Workflow Patterns** | Task execution methodology | Agentic systems |
| **Conditional Rules** | If/then behavioral triggers | Context-dependent behavior |

### Component Checklist

```
[ ] Identity defined (role, expertise, personality)
[ ] Capabilities stated explicitly
[ ] Limitations stated explicitly
[ ] Tool rules documented (if applicable)
[ ] Safety boundaries established
[ ] Output format specified
[ ] Tone/style defined
[ ] Edge cases handled with conditionals
```

---

## 2. The 8 Patterns That Make Prompts Performant

### Pattern 1: Repetition for Critical Rules

Critical constraints should appear 2-3 times in different sections. Models weight repeated instructions higher.

**Template:**
```
# Early in prompt
IMPORTANT: Never execute code without user confirmation.

# In tool section
When using code execution tools, ALWAYS confirm with user first.

# In examples section
Bad: *executes rm -rf without asking*
Good: "I can delete these files. Should I proceed?"
```

**Emphasis markers by severity:**
- `CRITICAL` / `NEVER` - Absolute constraints
- `IMPORTANT` / `ALWAYS` - Strong requirements
- `Note:` / `Tip:` - Guidance

### Pattern 2: Hierarchical Constraints

Create clear priority ordering using modal verbs:

| Level | Keyword | Meaning |
|-------|---------|---------|
| 1 | MUST / NEVER | Non-negotiable, override everything |
| 2 | SHOULD / SHOULD NOT | Strong preference, rare exceptions |
| 3 | MAY / CAN | Optional, context-dependent |
| 4 | PREFER | Default choice when ambiguous |

**Example:**
```
You MUST validate user input before database operations.
You SHOULD use parameterized queries.
You MAY use an ORM if the project already includes one.
PREFER explicit joins over subqueries for readability.
```

### Pattern 3: Parallelization-First

Default to parallel operations. Only use sequential when there are dependencies.

**Template:**
```
When multiple operations are independent:
- Execute them in parallel
- Do not wait for one to complete before starting another

When operations have dependencies:
- Identify the dependency chain
- Execute dependent operations sequentially
- Parallelize independent branches
```

**Example:**
```
Good: Read config.json, package.json, and README.md simultaneously
Bad: Read config.json, wait, then read package.json, wait, then read README.md

Good: Run lint and type-check in parallel (independent)
Bad: Run build before tests when tests require build output (dependent)
```

### Pattern 4: Plan-Before-Code

Assume discussion/planning intent unless explicit action words appear.

**Implementation:**
```
Action words that trigger implementation:
- "implement", "create", "build", "write", "add", "fix", "change"

Discussion words that trigger planning:
- "how would", "what if", "could we", "thoughts on", "approach for"

Default behavior: When ambiguous, ask for clarification or present a plan first.
```

**Example prompt section:**
```
Before writing code:
1. Confirm you understand the requirements
2. Outline your approach
3. Identify files that will change
4. Get user approval for non-trivial changes

Skip planning only when:
- User explicitly says "just do it" or "implement now"
- Change is trivial (typo fix, single-line change)
```

### Pattern 5: Research-Before-Assumptions

Mandate exploration before making changes. Multiple search passes catch edge cases.

**Template:**
```
Before modifying code:
1. Read the file(s) you intend to change
2. Search for related usages (grep for function names, imports)
3. Check for tests that cover this code
4. Look for documentation or comments explaining intent

NEVER assume:
- A function is unused (search first)
- A pattern is incorrect (understand context first)
- A dependency is unnecessary (check usages first)
```

### Pattern 6: Examples Over Abstractions

One concrete example beats ten abstract rules. Show input→output pairs.

**Anti-pattern:**
```
Format responses appropriately based on context and user needs.
```

**Better:**
```
Format responses based on complexity:

Simple question → Direct answer
"What's 2+2?" → "4"

Explanation needed → Brief context + answer
"Why use const?" → "const prevents reassignment, catching accidental mutations. Use it by default."

Complex topic → Structured response
"Explain React hooks" →
  1. One-sentence summary
  2. Core concept (2-3 sentences)
  3. Code example
  4. Common pitfalls
```

### Pattern 7: Token Efficiency

Set explicit length limits. "Concise" is ambiguous; "under 3 sentences" is not.

**Template:**
```
Response length guidelines:
- Direct answers: 1-2 sentences
- Explanations: 3-5 sentences unless complexity requires more
- Code comments: 1 line per non-obvious decision
- Error messages: State problem + solution, nothing else

Expand only when:
- User explicitly asks for detail
- Topic requires nuance to avoid misunderstanding
- Code example needs context to be useful
```

### Pattern 8: Progressive Disclosure

Structure prompts from general to specific: Identity → Context → Tools → Constraints → Examples.

Place critical rules at beginning AND end (primacy and recency effects).

**Template structure:**
```
# Identity (who you are)
# Context (environment, capabilities)
# Tools (what you can use)
# Workflow (how to approach tasks)
# Constraints (what you must/must not do)
# Communication (how to respond)
# Examples (concrete demonstrations)
# Final reminders (critical rules repeated)
```

---

## 3. Structural Templates

### Template A: Tool-Based Agent

```markdown
# Identity
You are [role] that helps users [primary purpose].

# Environment
- Working directory: {cwd}
- Available tools: {tool_list}
- Platform: {platform}

# Tool Usage Rules
## [Tool Name]
- Purpose: [when to use]
- Constraints: [limitations]
- Example: [usage pattern]

# Workflow
1. Understand the request
2. Research before acting (read files, search codebase)
3. Plan approach for non-trivial tasks
4. Execute with appropriate tools
5. Verify results

# Communication Style
- Be concise and direct
- Use markdown formatting
- Show code in fenced blocks
- State assumptions explicitly

# Safety Constraints
NEVER:
- Execute destructive commands without confirmation
- Access files outside the project
- Expose secrets or credentials

ALWAYS:
- Validate user input
- Confirm before bulk operations
- Respect .gitignore patterns

# Examples
[2-3 concrete input/output examples]

# Critical Reminders
[Repeat top 2-3 most important rules]
```

### Template B: Chat-Based Assistant

```markdown
# Identity
You are [role] specializing in [domain].

# Capabilities
You CAN:
- [Capability 1]
- [Capability 2]

You CANNOT:
- [Limitation 1]
- [Limitation 2]

# Response Format
Structure: [format description]
Length: [specific limits]
Tone: [personality traits]

# Constraints
[Priority-ordered rules using MUST/SHOULD/MAY]

# Examples
Input: [example query]
Output: [example response]

Input: [edge case]
Output: [handling of edge case]
```

### Template C: Code Review Agent

```markdown
# Identity
You review code for [quality dimensions].

# Review Criteria
## Must Fix (blocking)
- Security vulnerabilities
- Logic errors
- Breaking changes

## Should Fix (important)
- Performance issues
- Code style violations
- Missing error handling

## Consider (suggestions)
- Readability improvements
- Alternative approaches

# Output Format
For each issue:
1. Location (file:line)
2. Severity (must/should/consider)
3. Problem description
4. Suggested fix

# Constraints
- Review only changed lines unless bug affects unchanged code
- Don't nitpick formatting if linter handles it
- Praise good patterns briefly
```

---

## 4. Anti-Pattern Checklist

Avoid these common mistakes:

### Structure Problems
- [ ] **Prose walls** - Use headers, bullets, tables instead
- [ ] **No hierarchy** - Add clear sections and nesting
- [ ] **Buried critical rules** - Move to top and repeat at end

### Clarity Problems
- [ ] **Rules without examples** - Add input/output pairs
- [ ] **Contradictory instructions** - Audit for conflicts
- [ ] **Ambiguous language** - Replace "appropriate" with specific criteria
- [ ] **Missing edge cases** - Add conditional rules for exceptions

### Completeness Problems
- [ ] **No safety boundaries** - Add explicit constraints
- [ ] **No priority ordering** - Use MUST/SHOULD/MAY hierarchy
- [ ] **No escape hatches** - Define when rules can be overridden

### Efficiency Problems
- [ ] **Overly verbose** - Cut redundant explanations
- [ ] **No length limits** - Add specific response size guidance
- [ ] **Repeated similar rules** - Consolidate into single clear statement

---

## 5. Quick Reference Cheatsheet

### Emphasis Markers
```
CRITICAL/NEVER  → Absolute constraint
IMPORTANT/ALWAYS → Strong requirement
SHOULD/PREFER   → Default behavior
MAY/CAN         → Optional
```

### Response Structure
```
Simple query    → Direct answer (1-2 sentences)
Explanation     → Context + answer (3-5 sentences)
Complex topic   → Headers + bullets + examples
Code request    → Plan → implement → verify
```

### Tool Sequencing
```
Read before write
Search before assume
Plan before implement
Verify before complete
Parallel when independent
Sequential when dependent
```

### Safety Defaults
```
Confirm destructive operations
Validate external input
Never expose secrets
Respect file boundaries
```

### Prompt Structure Order
```
1. Identity (who)
2. Context (where/when)
3. Tools (what)
4. Workflow (how)
5. Constraints (limits)
6. Style (tone)
7. Examples (demonstrations)
8. Reminders (critical rules again)
```

### The 8 Patterns Summary
```
1. Repetition      - Critical rules appear 2-3 times
2. Hierarchy       - MUST > SHOULD > MAY ordering
3. Parallelization - Default parallel, sequential only if dependent
4. Plan-first      - Discuss before implementing
5. Research-first  - Explore before assuming
6. Examples        - Concrete > abstract
7. Token limits    - Specific length constraints
8. Progressive     - General → specific structure
```

---

## Appendix: Pattern Combinations

High-stakes operations need multiple patterns together:

**File Deletion Example:**
```
[Repetition] NEVER delete files without explicit user confirmation.

[Hierarchy] You MUST confirm before any destructive operation.

[Research-first] Before suggesting deletion, search for usages.

[Examples]
User: "Clean up unused files"
Bad: *deletes files immediately*
Good: "I found 3 potentially unused files:
  - old-config.json (no imports found)
  - temp.txt (created today)
  - backup.sql (referenced in deploy script)

  Should I delete the first two? I recommend keeping backup.sql."

[Repetition again] Remember: ALWAYS confirm before deleting.
```

This layered approach ensures the constraint is understood, prioritized, and demonstrated.
