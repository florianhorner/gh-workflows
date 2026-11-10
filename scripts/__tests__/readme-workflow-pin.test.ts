import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";

// Reviewed at this immutable commit: POST /markdown in gfm mode,
// cleanIntegrateWitness, pinned script checkout, PR_BASE_REF and full history
// for CI-run proofs. A different SHA requires reviewing its workflow and
// validator before changing this contract. No network or git history needed.
const reviewedSha = "9085c9da024edbfd5fafbd8801d996776c4fdbcf";
const workflowPath = "florianhorner/gh-workflows/.github/workflows/verify-claims.yml";
const readme = readFileSync(`${import.meta.dir}/../../README.md`, "utf8");
const caller = readme.split("### Caller workflow\n")[1]?.split("### Proof syntax\n")[0] ?? "";
const examples = [...caller.matchAll(/```yaml\n([\s\S]*?)\n```/g)];

describe("README verify-claims caller", () => {
  it("pins the reviewed validator with rendered proof and clean integration", () => {
    expect(examples).toHaveLength(1);
    const workflow = parseYaml(examples[0]![1]!);
    expect(workflow.jobs.verify.uses).toBe(`${workflowPath}@${reviewedSha}`);
    expect(caller).toContain(`# merged main commit; no release tag`);
    expect(caller).toContain("This commit has no release tag.");
    expect(caller).toContain("do not substitute `v1.5`");
  });

  it("grants the read permissions required by the reviewed callee", () => {
    const workflow = parseYaml(examples[0]![1]!);
    expect(workflow.jobs.verify.permissions).toEqual({ contents: "read", actions: "read" });
    expect(workflow.jobs.verify.with.owned_repos).toBeTruthy();
  });

  it("runs this contract on README-only changes", () => {
    const ci = parseYaml(readFileSync(`${import.meta.dir}/../../.github/workflows/workflow-lint.yml`, "utf8"));
    expect(ci.on.pull_request.paths).toContain("README.md");
    expect(ci.on.push.paths).toContain("README.md");
  });
});
