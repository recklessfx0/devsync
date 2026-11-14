import { describe, expect, it } from "vitest";
import {
  PATCH_ARTIFACT,
  RESULT_ARTIFACT,
  WORKFLOW,
  WORKFLOW_FILE,
  WORKFLOW_PATH,
} from "./workflow";

const FAILURES = [
  "agent-failed",
  "budget",
  "turns",
  "no-changes",
  "patch-did-not-apply",
  "patch-touches-workflows",
  "push-failed",
  "pull-request-not-allowed",
];

const lines = WORKFLOW.split("\n");
const indent = (line: string) => line.length - line.trimStart().length;

/** The lines nested under `lines[at]`: those indented deeper than `depth`, up to the first not. */
function nested(text: string[], at: number, depth = indent(text[at] ?? "")): string[] {
  const end = text.findIndex((line, i) => i > at && line.trim() !== "" && indent(line) <= depth);
  return text.slice(at + 1, end < 0 ? undefined : end);
}

/** The lines nested under the first line that matches `key`. */
function under(text: string[], key: RegExp): string[] {
  const at = text.findIndex((line) => key.test(line));
  if (at < 0) throw new Error(`No line matches ${key}`);
  return nested(text, at);
}

/** The keys of a mapping's lines, at the mapping's own indentation. */
function keys(mapping: string[]): string[] {
  const depth = Math.min(...mapping.filter((line) => line.trim() !== "").map(indent));
  return mapping
    .filter((line) => indent(line) === depth && !line.trim().startsWith("#"))
    .map((line) => line.trim().split(":")[0] ?? "");
}

const job = (name: string) => under(lines, new RegExp(`^ {2}${name}:$`));

/** A job's steps, each as its lines from its `- ` on. */
function steps(name: string): string[][] {
  const result: string[][] = [];
  for (const line of job(name)) {
    if (/^ {6}- /.test(line)) result.push([line]);
    else result.at(-1)?.push(line);
  }
  return result;
}

const step = (name: string, title: string) => {
  const found = steps(name).find((candidate) => candidate[0] === `      - name: ${title}`);
  if (!found) throw new Error(`No step "${title}" in ${name}`);
  return found;
};

/** Every `run:` script in the file, its lines joined. */
function scripts(): string[] {
  return lines.flatMap((line, at) => {
    const match = /^( *)run:(.*)$/.exec(line);
    if (!match) return [];
    return [[match[2] ?? "", ...nested(lines, at, match[1]?.length)].join("\n")];
  });
}

const text = (block: string[]) => block.join("\n");
/** A GitHub Actions expression as the file writes it. */
const expression = (inner: string) => `\${{ ${inner} }}`;

describe("the managed runs' workflow file", () => {
  it("is devsync.yml, dispatched with exactly the two string inputs", () => {
    expect(WORKFLOW_FILE).toBe("devsync.yml");
    expect(WORKFLOW_PATH).toBe(".github/workflows/devsync.yml");
    expect(keys(under(lines, /^on:$/))).toEqual(["workflow_dispatch"]);
    const inputs = under(lines, /^ {4}inputs:$/);
    expect(keys(inputs)).toEqual(["run_id", "task"]);
    for (const input of ["run_id", "task"]) {
      const fields = under(inputs, new RegExp(`^ {6}${input}:$`)).map((line) => line.trim());
      expect(fields).toContain("required: true");
      expect(fields).toContain("type: string");
    }
  });

  it("runs one run id at a time", () => {
    expect(text(under(lines, /^concurrency:$/))).toContain(
      `group: devsync-${expression("inputs.run_id")}`,
    );
  });

  it("grants nothing at the top, and each job only what it needs", () => {
    expect(lines).toContain("permissions: {}");
    expect(keys(under(lines, /^jobs:$/))).toEqual(["agent", "publish", "report"]);
    expect(under(job("agent"), /^ {4}permissions:$/).map((line) => line.trim())).toEqual([
      "contents: read",
    ]);
    expect(under(job("publish"), /^ {4}permissions:$/).map((line) => line.trim())).toEqual([
      "contents: write",
      "pull-requests: write",
    ]);
    expect(job("report")).toContain("    permissions: {}");
  });

  it("gives the Claude API key only to the step that runs Claude Code", () => {
    expect(WORKFLOW.match(/secrets\./g)).toHaveLength(1);
    const run = step("agent", "Run Claude Code");
    const mentions = (source: string) => source.match(/ANTHROPIC/g)?.length ?? 0;
    expect(mentions(text(run))).toBeGreaterThan(0);
    expect(mentions(WORKFLOW)).toBe(mentions(text(run)));
    expect(under(run, /^ {8}env:$/)).toEqual([
      `          ANTHROPIC_API_KEY: ${expression("secrets.ANTHROPIC_API_KEY")}`,
    ]);
    expect(text(run)).toContain(`claude "\${flags[@]}"`);
  });

  it("refuses a change that holds the key, in that step, never putting the key in argv", () => {
    const run = text(step("agent", "Run Claude Code"));
    const guard = run.indexOf('if [ -z "$failure" ] && [ -n "$ANTHROPIC_API_KEY" ]; then');
    const files = run.indexOf("grep -rqF --exclude-dir=.git -f <(printenv ANTHROPIC_API_KEY) .");
    const names = run.indexOf(
      "find . -name .git -prune -o -print | grep -qF -f <(printenv ANTHROPIC_API_KEY)",
    );
    const refusal = run.indexOf(
      'echo "::error::The change holds the Claude API key, so it is not published."',
    );
    const output = run.indexOf('echo "failure=$failure" >> "$GITHUB_OUTPUT"');
    for (const at of [guard, files, names, refusal]) {
      expect(at).toBeGreaterThan(run.indexOf("code=$?"));
      expect(at).toBeLessThan(output);
    }
    expect(run.slice(refusal, output)).toContain("failure=agent-failed");
    expect(run.match(/\$ANTHROPIC_API_KEY/g)).toHaveLength(1);
  });

  it("keeps the write token out of the agent job, which checks out without credentials", () => {
    expect(text(step("agent", "Check out the repository"))).toContain("persist-credentials: false");
    expect(text(job("agent"))).not.toMatch(/\bref:|github\.token|GH_TOKEN/);
    expect(text(job("report"))).not.toMatch(/github\.token|GH_TOKEN/);
    expect(text(step("publish", "Push the branch and open a draft pull request"))).toContain(
      `GH_TOKEN: ${expression("github.token")}`,
    );
  });

  it("hands the inputs to scripts only through env", () => {
    const all = scripts();
    expect(all).toHaveLength(6);
    for (const script of all) expect(script).not.toContain("${{");
    const uses = lines.filter((line) => line.includes("inputs."));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line).toMatch(
        /^( {10}[A-Z_]+: \$\{\{ inputs\.(run_id|task) \}\}| {2}group: devsync-\$\{\{ inputs\.run_id \}\})$/,
      );
    }
  });

  it("runs a pinned Claude Code headless, with file tools only and nothing from the repository", () => {
    const install = text(step("agent", "Install Claude Code"));
    const version = /@anthropic-ai\/claude-code@(\d+)\.(\d+)\.(\d+)\n/.exec(install);
    expect(version).not.toBeNull();
    const [major = 0, minor = 0, patch = 0] = (version ?? []).slice(1).map(Number);
    expect(major).toBe(2);
    expect(minor * 1000 + patch).toBeGreaterThanOrEqual(1259);

    const run = text(step("agent", "Run Claude Code"));
    for (const flag of [
      "--bare -p --output-format json",
      '--model "$DEVSYNC_MODEL"',
      '--max-turns "$DEVSYNC_MAX_TURNS"',
      '--max-budget-usd "$DEVSYNC_MAX_BUDGET_USD"',
      '--tools "Read,Glob,Grep,Edit,Write"',
      '--disallowedTools "Bash,WebFetch,WebSearch,mcp__*"',
      "--permission-mode acceptEdits",
      "--permission-prompts none",
      `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`,
      "--setting-sources user",
      `--settings '{"disableAllHooks":true,"permissions":{"blockReadsOutsideWorkingDirectories":true,"deny":["Read(//proc/**)"]}}'`,
      "--disable-slash-commands",
      "--no-session-persistence",
    ]) {
      expect(run).toContain(flag);
    }
    const mode = run.split("\n").find((line) => line.includes("--permission-mode"));
    expect(mode).toMatch(/--permission-mode acceptEdits +# .*never .*auto.*bypassPermissions/);
    expect(run).toContain("untrusted data");
    expect(run).toContain('< "$RUNNER_TEMP/task.json"');
    expect(under(job("agent"), /^ {4}env:$/).map((line) => line.trim())).toEqual([
      "# The model, the turn cap and the spend cap (US dollars) of every run: edit them here.",
      "DEVSYNC_MODEL: sonnet",
      'DEVSYNC_MAX_TURNS: "40"',
      'DEVSYNC_MAX_BUDGET_USD: "5.00"',
    ]);
  });

  it("hands the change over as one patch artifact and leaves the result in another", () => {
    const artifact = (block: string[]) => {
      const name = block.find((line) => line.trim().startsWith("name: devsync-"));
      return name?.trim().slice("name: ".length);
    };
    const uploads = ["agent", "publish", "report"].flatMap((name) =>
      steps(name).filter((candidate) =>
        text(candidate).includes("uses: actions/upload-artifact@v7"),
      ),
    );
    expect(uploads.map(artifact)).toEqual([PATCH_ARTIFACT, RESULT_ARTIFACT]);
    expect(text(step("agent", "Upload the patch"))).toContain("retention-days: 1");
    expect(text(step("report", "Upload the result"))).toContain("retention-days: 7");
    expect(artifact(step("publish", "Download the patch"))).toBe(PATCH_ARTIFACT);
    expect(artifact(step("report", "Download the changed files"))).toBe(PATCH_ARTIFACT);
    expect(text(step("agent", "Build the patch"))).toContain("git diff --cached --binary");
  });

  it("publishes only a change, refusing one that touches .github/", () => {
    expect(job("publish")).toContain("    needs: agent");
    expect(job("publish")).toContain("    if: needs.agent.outputs.has_changes == 'true'");
    const publish = text(step("publish", "Push the branch and open a draft pull request"));
    expect(publish).toMatch(
      /if ! git diff --cached --quiet -- ':\(icase\)\.github'; then\n +fail patch-touches-workflows\n/,
    );
    expect(publish).not.toContain("grep");
    expect(publish).toContain('git push --quiet origin "$branch"');
    expect(publish).toContain('gh pr create --draft --base "$GITHUB_REF_NAME" --head "$branch"');
  });

  it("always reports, and only the design's failures", () => {
    expect(job("report")).toContain("    needs: [agent, publish]");
    expect(job("report")).toContain("    if: always()");
    const write = text(step("report", "Write the result"));
    for (const field of [
      "schemaVersion: 1",
      "runId:",
      "status:",
      "failure:",
      "changedFiles:",
      "usage:",
      "models:",
      "pullRequestUrl:",
      "branch:",
    ]) {
      expect(write).toContain(field);
    }
    expect(text(step("agent", "Run Claude Code"))).toMatch(
      /error_max_budget_usd \]; then\n {12}failure=budget\n.*error_max_turns \]; then\n {12}failure=turns/,
    );
    const written = [...WORKFLOW.matchAll(/(?:failure=|fail )([a-z][a-z-]*)/g)].map((m) => m[1]);
    expect(new Set(written)).toEqual(new Set(FAILURES));
  });
});
