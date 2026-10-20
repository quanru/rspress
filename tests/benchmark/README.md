# Rspress migration comparison

This fork-only experiment pins PR #3768 base `e594d85` and head `7fb151b`.
Three sequential fresh Ubuntu 24.04 runners each execute the original deterministic
suite, retained deterministic suite, and all 153 Midscene cases. Test retries are
disabled in both frameworks. Tests and model settings are not tuned between rounds.
All outcomes, including setup failures and unexecuted tests, must be reported.

The workflow replaces the existing dispatchable workflow only on this experiment
branch. It does not change the upstream PR, publish Pages, or delete existing reports.

Report separately:

- Test-only duration, setup/build duration, and complete job wall time.
- Before = baseline deterministic suite; after = retained deterministic suite plus
  AI suite. Sequential total and possible parallel critical path are different.
- First-attempt passed/failed/not-run counts and all-green rounds out of three.
- Per-case consistency and failure causes with original native report evidence.
- Median/min/max rather than a meaningful p95 estimate from only three samples.

The migration changes coverage and granularity, so aggregate durations are a
deployment-cost comparison, not equal-work engine throughput. Both candidates use
the same product code baseline; upstream additions are included in both sides.
Builds run baseline first, which may warm the package store for the candidate.
Setup durations must not be represented as an unbiased cold-install comparison.

Passing known-good tests measures observed stability, not bug-detection accuracy.
Do not claim precision, recall, or improved defect detection without independently
labelled fault-injection experiments. Three repetitions of a case are a small sample.
