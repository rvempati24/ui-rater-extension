# UI Rater Analysis

This context describes the language for turning one participant's task attempt into evidence-grounded UX findings and, optionally, source-code candidates.

## Language

### Study orchestration

**Website Artifact**:
An immutable generated or imported synthetic website bundle together with its normalized task catalog.
_Avoid_: App, website run, dist folder

**Website Acquisition**:
The immutable provenance record describing how one Website Artifact was generated or imported. Different acquisitions may resolve to identical artifact content.
_Avoid_: Download job, source folder

**Website Deployment**:
A reachable instance of one Website Artifact whose base URL remains stable while it is in use.
_Avoid_: Website server, localhost port

**Study Revision**:
An immutable binding between one Website Deployment and an ordered snapshot of selected tasks.
_Avoid_: Current config, active website, trial config

**Study Admission**:
The mutable decision whether a Study Revision may create new Participant Runs. Closing admission does not interrupt existing Participant Runs.
_Avoid_: Study shutdown, server shutdown

**Participant Run**:
One configured round of work performed by one participant against exactly one Study Revision.
_Avoid_: Run, session

**Task Assignment**:
One selected task at a fixed position in a Participant Run.
_Avoid_: Trial, task config

### Evidence and analysis

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

**Video-Derived Snapshot**:
A deterministic decoded frame associated with a same-family interaction burst, normally 75 ms before its first event or 75 ms after its last event.
_Avoid_: Live screenshot, settled state

**Friction Signal**:
A mechanically derived behavioral pattern that may indicate difficulty, such as repeated clicks, backtracking, or a long dwell.
_Avoid_: UX problem, failure

**UX Finding**:
A model-generated, evidence-linked claim about a possible usability issue, its severity, confidence, and task impact. It does not prescribe a fix.
_Avoid_: Recommendation, diagnosis

**Evidence Bundle**:
The bounded set of task context, Interaction Trace segments, Evidence Snapshots, and Friction Signals supplied to a UX critic.
_Avoid_: Prompt, context dump

**Source Candidate**:
A code location plausibly responsible for a UX Finding, proposed for developer review.
_Avoid_: Root cause, fix location
