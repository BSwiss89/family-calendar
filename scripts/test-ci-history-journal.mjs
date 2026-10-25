// CI history archive fixtures use a mocked GitHub API; they write no real issue.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow = readFileSync(new URL('../.github/workflows/build.yml', import.meta.url), 'utf8');
const marker = '          script: |\n';
const lastMarker = workflow.lastIndexOf(marker);
assert.ok(lastMarker > workflow.indexOf('\n  ci-history:'), 'CI history script missing');
const script = workflow.slice(lastMarker + marker.length).split('\n')
  .map(line => line.startsWith('            ') ? line.slice(12) : line).join('\n').trim();
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const execute = new AsyncFunction('github', 'context', 'core', script);

function job(result, at) {
  return [{
    name: 'frontend-build',
    status: 'completed',
    conclusion: result,
    started_at: at,
    completed_at: '2026-10-25T14:51:33Z',
    steps: [
      { number: 1, name: 'Setup', conclusion: 'success', completed_at: at },
      { number: 2, name: 'Household A and B isolation', conclusion: result, completed_at: at }
    ]
  }];
}

function mock(attemptJobs, { comments = [], invalidRepository = false, failWrite = false } = {}) {
  const run_id = 40203806736;
  const persisted = comments.slice();
  const jobsRoute = Symbol('workflow-attempt-jobs');
  const commentsRoute = Symbol('issue-comments');
  const github = {
    rest: {
      actions: {
        getWorkflowRun: async () => ({
          data: {
            name: 'Build Family Calendar',
            event: 'pull_request',
            repository: { full_name: invalidRepository ? 'other/repo' : 'BSwiss89/family-calendar' },
            head_sha: 'ff18efc6601d7b296d7635c8e9cdb7ac5aa63492'
          }
        }),
        listJobsForWorkflowRunAttempt: jobsRoute
      },
      issues: {
        listComments: commentsRoute,
        createComment: async ({ owner, repo, issue_number, body }) => {
          assert.equal(owner, 'BSwiss89');
          assert.equal(repo, 'family-calendar');
          assert.equal(issue_number, 84);
          if (failWrite) throw Error('GitHub unavailable');
          persisted.push({ body, user: { login: 'github-actions[bot]' } });
        }
      }
    },
    paginate: async (route, args) => {
      if (route === commentsRoute) return persisted.slice();
      assert.equal(route, jobsRoute);
      assert.equal(args.run_id, run_id);
      return attemptJobs[args.attempt_number] || [];
    }
  };
  const core = { info: () => {} };
  async function run(attempt) {
    return execute(github, {
      repo: { owner: 'BSwiss89', repo: 'family-calendar' },
      runId: run_id,
      runAttempt: attempt
    }, core);
  }
  return { run, persisted };
}

test('history job is isolated with read-only Actions and issue-only write scope', () => {
  const jobBody = workflow.slice(workflow.lastIndexOf('\n  ci-history:'));
  assert.match(workflow, /permissions:\n  contents: read/);
  assert.match(jobBody, /needs: frontend-build/);
  assert.match(jobBody, /always\(\)/);
  assert.match(jobBody, /pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(jobBody, /actions: read\n      issues: write/);
  assert.doesNotMatch(jobBody, /actions\/checkout|npm ci|pull_request_target/);
});

test('first failed attempt is preserved, then successful rerun is a separate record', async () => {
  const f = mock({
    1: job('failure', '2026-10-25T14:46:28Z'),
    2: job('success', '2026-10-25T14:52:18Z')
  });
  await f.run(1);
  assert.equal(f.persisted.length, 1);
  const original = f.persisted[0].body;
  assert.match(original, /CI attempt 1 — FAIL/);
  assert.match(original, /Household A and B isolation \| failure/);
  assert.match(original, /10\/25\/2026/);
  assert.match(original, /CDT/);
  await f.run(2);
  assert.equal(f.persisted.length, 2);
  assert.equal(f.persisted[0].body, original, 'original failure must not be edited');
  assert.match(f.persisted[1].body, /CI attempt 2 — PASS/);
  await f.run(2);
  assert.equal(f.persisted.length, 2, 'retrying the logger should not duplicate records');
});

test('a first successful logger execution on attempt 2 backfills attempt 1', async () => {
  const f = mock({
    1: job('failure', '2026-10-25T14:46:28Z'),
    2: job('success', '2026-10-25T14:52:18Z')
  });
  await f.run(2);
  assert.equal(f.persisted.length, 2);
  assert.match(f.persisted[0].body, /CI attempt 1 — FAIL/);
  assert.match(f.persisted[1].body, /CI attempt 2 — PASS/);
});

test('history-only rerun never gets an invented successful test result', async () => {
  const f = mock({
    1: job('success', '2026-10-25T14:46:28Z'),
    2: []
  });
  await f.run(2);
  assert.match(f.persisted[1].body, /CI attempt 2 — NO TEST JOB RERUN/);
  assert.match(f.persisted[1].body, /no test job was executed/);
});

test('user-posted forged marker cannot block trusted Actions history', async () => {
  const f = mock({ 1: job('failure', '2026-10-25T14:46:28Z') }, {
    comments: [{
      body: '<!-- fc-ci-attempt:v1:40203806736:1 -->',
      user: { login: 'untrusted-user' }
    }]
  });
  await f.run(1);
  assert.equal(f.persisted.length, 2);
  assert.match(f.persisted[1].body, /CI attempt 1 — FAIL/);
});

test('API write failures fail the history job, not claim durable success', async () => {
  const f = mock({ 1: job('failure', '2026-10-25T14:46:28Z') }, { failWrite: true });
  await assert.rejects(f.run(1), /GitHub unavailable/);
  assert.equal(f.persisted.length, 0);
});

test('incorrect repository identity refuses to record any history', async () => {
  const f = mock({ 1: job('success', '2026-10-25T14:46:28Z') }, { invalidRepository: true });
  await assert.rejects(f.run(1), /identity mismatch/);
  assert.equal(f.persisted.length, 0);
});
