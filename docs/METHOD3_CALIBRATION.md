# Method 3 recording alignment calibration

This gate measures the error between an interaction timestamp and the corresponding visible transition in the recorded WebM. It must be completed before the video-derived Method 3 path is documented as the production default.

1. Use the production Chrome build, extension package, VP8 tab-capture profile, and Collection server.
2. Run at least 30 scripted visible transitions distributed across task start, middle, navigation, typing, scrolling, and task end. Each transition must emit a trace event with a known `ts` and produce an unambiguous pixel change.
3. Probe every WebM frame PTS. For each transition, record the absolute difference between the mapped trace time and the first frame containing the transition.
4. Record all samples, the maximum, median, and p95 absolute error in an immutable artifact. Set `status` to `passed` only when p95 is at most 50 ms and the actual recording cadence satisfies the frame policy.
5. Review burst coverage and the before/after pair quality on the same cohort. Hash the finalized artifact; materialization binds that hash, browser build, capture profile, and policy hash into the case revision.

A failed gate requires a new versioned calibration or frame policy. Do not edit an already-used artifact or silently fall back to live screenshots.
