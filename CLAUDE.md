# gh-workflows

The workflows here are merge gates that other repositories call by pinned SHA.
A defect in one reaches every caller the next time it bumps the pin, so a
change to a gate gets one review beyond the bots.

## Trust-boundary changes get one top-tier model review before merge (provisional)

A pull request that changes a gate, or code or tests a gate depends on, gets one
review of its full diff before merge by the most capable Claude model available,
at effort `high`, in a Claude Code session on a checkout of the pull request
head. The review bots stay as they are. Post the findings on the pull request
and handle each one like a bot finding: fix it, or answer it with a reason.

- **Trigger:** the pull request changes `.github/workflows/**`, `scripts/**` or
  `tests/**`.
- **Not covered: pin-only changes.** A change that only replaces pinned SHAs and
  their version comments gets no model review, because the reviewer cannot see
  upstream code. `pin-check.yml` checks it instead: every pin is a full SHA, the
  tag its comment names is at that commit, and a called reusable workflow asks
  for no permission its caller does not grant.
- **Changes a pull request cannot run.** `checkout-credentials-caller.yml` and
  `pin-check-caller.yml` run on `pull_request_target`, which loads the workflow
  from the base branch, so a pull request's edits to those gates take effect
  only after merge. Watch the first run after merging such a change.
- **Why provisional.** On three past trust-boundary changes, the most capable
  models found about twice as many of the problems that later fixes proved as
  the cheapest configuration did, and on the one change with a record of what
  the review bots raised, the most capable model found more. At effort `high`
  that costs a few dollars and about six minutes per review; effort `max` found
  little more at about three times the cost. One run per configuration cannot
  size these gaps, so narrow or drop the rule if later reviews do not show them.
