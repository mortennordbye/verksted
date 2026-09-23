/**
 * What gh answers, as the tests stand it in. Hand-written from the \`--json\`
 * shape, so gh-shape.test.ts holds them against a real gh in CI: a field gh
 * renames fails there rather than passing here and breaking the app.
 */
export const PR = {
  number: 7,
  title: "add the thing",
  state: "OPEN",
  isDraft: false,
  headRefName: "feature-x",
  baseRefName: "main",
  author: { login: "morten" },
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-02T00:00:00Z",
  url: "https://github.com/o/r/pull/7",
  reviewDecision: "APPROVED",
  statusCheckRollup: [
    { status: "COMPLETED", conclusion: "SUCCESS" },
    { status: "COMPLETED", conclusion: "FAILURE" },
  ],
  additions: 10,
  deletions: 2,
  changedFiles: 3,
};

export const RUN = {
  databaseId: 42,
  displayTitle: "fix the thing",
  workflowName: "ci",
  status: "completed",
  conclusion: "failure",
  event: "push",
  headBranch: "main",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:05:00Z",
  url: "https://github.com/o/r/actions/runs/42",
};
