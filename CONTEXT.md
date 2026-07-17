# UI Rater Analysis

This context describes the language for turning one participant's task attempt into evidence-grounded UX findings and, optionally, source-code candidates.

## Language

**Task Attempt**:
One participant's execution of one configured task from start through completion, skip, or abandonment.
_Avoid_: Session, run, recording

**Interaction Event**:
One time-ordered user or browser action observed during a Task Attempt, such as a click, scroll, focus change, or navigation.
_Avoid_: Log line, raw action

**Interaction Trace**:
The ordered, normalized sequence of Interaction Events for one Task Attempt.
_Avoid_: Mouse trace, video trace

**UI State**:
The user-visible and semantically relevant condition of the page at a point in a Task Attempt.
_Avoid_: Page, screen, transaction

**Evidence Snapshot**:
A timestamped visual capture and compact semantic description of one UI State.
_Avoid_: Screenshot, DOM dump

**Friction Signal**:
A mechanically derived behavioral pattern that may indicate difficulty, such as repeated clicks, backtracking, or a long dwell.
_Avoid_: UX problem, failure

**UX Finding**:
A model-generated, evidence-linked claim about a possible usability issue, its severity, and a suggested improvement.
_Avoid_: Recommendation, diagnosis

**Evidence Bundle**:
The bounded set of task context, Interaction Trace segments, Evidence Snapshots, and Friction Signals supplied to a UX critic.
_Avoid_: Prompt, context dump

**Source Candidate**:
A code location plausibly responsible for a UX Finding, proposed for developer review.
_Avoid_: Root cause, fix location
