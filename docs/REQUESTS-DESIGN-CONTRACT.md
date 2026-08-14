# OpenCode Mobile Transcript Design Contract

Date: 2026-08-14
Scope: Phase 4, WP 4.1-4.2

## Subject and Direction

The subject is an **OpenCode Mobile developer transcript**: a chronological
record of a developer request, the assistant's response, and the terminal,
tool, review, approval, and failure evidence produced while doing the work. Its
single job is to make that execution record easy to scan and inspect on a
narrow screen without making it look like a consumer chat app.

The visual direction is restrained code-review and terminal editorial design.
Hierarchy comes from transcript rhythm, type, rules, and state color rather
than avatars, decorative gradients, or a stack of interchangeable rounded
cards. Existing navigation and toolbar hierarchy remain outside this scope.

## Compact Tokens

### Hierarchy and Surfaces

- Transcript canvas: existing screen background; assistant prose does not add
  a tinted container.
- Request surface: neutral `#F5F5F4` light / `#1C1C1C` dark, used only behind
  user prompts and kept inset from the leading edge.
- Assistant surface: transparent.
- Utility surface: `#FAFAFA` light / `#171717` dark for terminal and tool
  evidence where an enclosed reading area is necessary.
- Rules: `#D4D4D4` light / `#3A3A3A` dark for neutral separation; the selected
  app accent is reserved for the assistant execution rail and actionable state.
- Error: `#DC2626` light / `#F87171` dark, paired with text or icon rather than
  color alone.

### Type

- Response/body: platform sans, regular, at the user-selected message size;
  Markdown retains its existing semantic weights and code type.
- Request/body: platform sans, medium only through the stronger request
  surface and darker foreground, not a larger display size.
- Role/meta: platform sans, 11-12 pt, semibold, uppercase, modest letter
  spacing; model and token data remain secondary and truncate or wrap before
  body content is squeezed.
- Code/terminal: existing platform monospace. No new font dependency is added
  for a small transcript-only change.

### Spacing and Shape

- Message rhythm: 18-20 pt after a response, 14-16 pt after a compact request.
- Internal spacing: 6 pt role-to-content, 8-10 pt between evidence blocks.
- Request inset: 24 pt leading inset, 10-12 pt internal padding.
- Corners: 3-4 pt only where a bounded request or evidence surface needs an
  edge; avoid chat-bubble silhouettes and pills for structural content.
- Wide code and diffs retain horizontal scrolling; transcript containers must
  not impose a fixed width that clips them.

### Icons and Color

- No role avatars. In particular, no generic person or sparkle identity.
- Icons identify concrete state or action only: terminal, tool kind, question,
  permission, progress, success, and failure.
- Accent color identifies assistant execution and active controls. It does not
  tint the whole assistant response.
- Amber identifies running/shell attention, green completion, and red failure;
  every state also has a label, shape, or icon.

### Interaction

- User request long-press behavior and its current action semantics are
  unchanged; the whole request block remains the target.
- Tool and task expansion, exact subagent navigation, pending-question badges,
  questions, and permissions keep their existing controls and semantics.
- Streaming adds content without decorative animation. Stable completed rows
  retain the existing memoization contract and FlatList-friendly references.

### Light, Dark, and Accessibility

- Light and dark modes use neutral surfaces with the selected accent only on
  the rail/action layer; no palette assumes violet.
- Visible role labels are localized. Status remains understandable without
  color, touch targets retain current behavior, selectable content stays
  selectable, and text is allowed to grow.
- Headers may wrap on narrow screens; model metadata yields space before role
  identity or message content. No role uses oversized type that becomes a
  layout hazard under font scaling.

## Signature Element

The signature element is the **execution rail**: a two-point vertical rule at
the leading edge of assistant work, colored with the user's selected accent.
It borrows from code-review change bars and terminal process traces, so it
communicates “work produced here” without inventing an avatar or enclosing the
response in a branded card. It is intentionally the only expressive transcript
device; surrounding surfaces stay neutral.

## State Treatment

- User: compact neutral request block, inset and squared, with a localized
  request label.
- Assistant: open response aligned to the execution rail, with localized role
  label and secondary model metadata.
- Shell: monospace evidence row with terminal icon, command prompt, lifecycle
  label, output viewport, and amber rail.
- Tool/task: bounded only because it expands/collapses; tool status and task
  navigation remain explicit. Task keeps its accent rule and input badge.
- System: quiet inline notice with information icon, no card surface.
- Question/permission: retain stronger bounded prompts because they require an
  explicit decision and must not blend into transcript prose.
- Error: red rule/icon/text treatment attached to the affected message or tool,
  never represented by a red background alone.

## Self-Critique

The first-pass choices of hairline rules, uppercase metadata, neutral gray
surfaces, and monospace evidence are common developer-tool conventions. Used
alone, they could produce a generic log viewer. The revision rejects the most
generic options: no all-black terminal theme, no newspaper grid, no lavender AI
card, and no avatar-led chat layout. The execution rail is tied specifically to
OpenCode's assistant/tool lifecycle, while the offset request block preserves
the conversational turn boundary. Restraint is appropriate here because code,
diffs, questions, and task state must remain the most visually prominent
content.
