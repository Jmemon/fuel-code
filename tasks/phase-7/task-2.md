# Task 2: Change Orchestrator State Machine

## Parallel Group: B

## Dependencies: Task 1

## Description

Build the change orchestrator — the central coordination module that drives a change request through its lifecycle. It receives a change request ID and executes the workflow: provision remote → start headless CC → wait for completion → create branch → deploy preview → wait for approval → merge or cleanup.

The orchestrator is the "brain" of Phase 7. It is called by:
1. The Slack bot (Task 6) when a new change request arrives
2. The API endpoint (Task 3) when a change request is created via REST
3. The retry logic when a failed change request is retried

### Files to Create

**`packages/core/src/change-orchestrator.ts`**:

```typescript
import type { ChangeRequest } from '@fuel-code/shared';

export interface ChangeOrchestratorDeps {
  sql: postgres.Sql;
  changeQueries: ChangeRequestQueries;
  logger: pino.Logger;
  // Callback to provision a remote environment (calls Phase 5 API)
  provisionRemote: (params: ProvisionParams) => Promise<{ remoteEnvId: string }>;
  // Callback to get remote env status (polls Phase 5 API)
  getRemoteEnvStatus: (remoteEnvId: string) => Promise<RemoteEnvStatus>;
  // Callback to run headless CC on remote (Task 4)
  runHeadlessCC: (params: HeadlessCCParams) => Promise<HeadlessCCResult>;
  // Callback to start the app on remote for preview (Task 5)
  startPreview: (params: PreviewParams) => Promise<{ url: string }>;
  // Callback to merge branch (simple git merge on remote)
  mergeBranch: (params: MergeParams) => Promise<{ commitSha: string }>;
  // Callback to terminate remote env (calls Phase 5 API)
  terminateRemote: (remoteEnvId: string) => Promise<void>;
  // Callback to send progress updates (Slack thread or WebSocket)
  onProgress: (changeRequestId: string, status: string, message: string) => Promise<void>;
}

export interface ProvisionParams {
  workspaceId: string;
  changeRequestId: string;
  // Blueprint comes from workspace's detected or specified blueprint
}

export interface HeadlessCCParams {
  remoteEnvId: string;
  requestText: string;       // The change description from Slack/API
  branchName: string;        // Branch to create for the change
  workspacePath: string;     // Path to the repo on the remote
}

export interface HeadlessCCResult {
  success: boolean;
  sessionId: string | null;  // The CC session ID, if a session was created
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface PreviewParams {
  remoteEnvId: string;
  port: number;              // Port to expose for the preview
  startCommand?: string;     // Optional: command to start the app (auto-detected if not specified)
}

export interface MergeParams {
  remoteEnvId: string;
  branchName: string;
  targetBranch: string;      // Usually 'main'
  workspacePath: string;
}

export function createChangeOrchestrator(deps: ChangeOrchestratorDeps): ChangeOrchestrator;

export interface ChangeOrchestrator {
  // Execute the full change request workflow.
  // This is the main entry point — called when a change request is created.
  // Runs the workflow asynchronously and updates CR status at each stage.
  execute(changeRequestId: string): Promise<void>;

  // Resume a failed change request from its current status.
  // Useful for retrying after transient failures.
  resume(changeRequestId: string): Promise<void>;

  // Cancel a change request in progress.
  // Terminates the remote env if provisioned, cleans up branch.
  cancel(changeRequestId: string): Promise<void>;
}
```

### Orchestration Flow

```
execute(changeRequestId):

1. LOAD: Fetch CR from DB. Validate status is 'pending'.

2. PROVISION (pending → provisioning):
   a. Transition CR to 'provisioning'.
   b. Call provisionRemote({ workspaceId, changeRequestId }).
   c. Update CR with remote_env_id.
   d. Poll getRemoteEnvStatus() until 'ready' (or timeout after 20 min).
   e. On failure: transition to 'failed' with error, terminate remote, return.
   f. Send progress: "Environment provisioned."

3. IMPLEMENT (provisioning → implementing):
   a. Transition CR to 'implementing'.
   b. Generate branch name: `change/${slugify(request_text).slice(0, 50)}-${shortId}`.
   c. Update CR with branch_name.
   d. Call runHeadlessCC({ remoteEnvId, requestText, branchName, workspacePath }).
   e. If CC fails (exit code !== 0): transition to 'failed' with stderr, terminate remote, return.
   f. Update CR with session_id (from CC result).
   g. Send progress: "Claude finished implementing the change."

4. DEPLOY (implementing → deployed):
   a. Transition CR to 'deployed'.
   b. Call startPreview({ remoteEnvId, port: cr.preview_port }).
   c. Update CR with preview_url.
   d. Send progress: "Preview ready: {url}"

5. WAIT FOR APPROVAL:
   - The orchestrator does NOT poll for approval.
   - The API endpoint (Task 3) handles approve/reject.
   - When approved: the API calls orchestrator.handleApproval().
   - When rejected: the API calls orchestrator.handleRejection().

handleApproval(changeRequestId):
   a. Transition CR to 'merging' (from 'approved' — the API already set 'approved').
   b. Actually, the API sets 'approved', then calls this.
   c. Wait actually: let's simplify. The approve API endpoint transitions to 'approved',
      then calls orchestrator.merge(changeRequestId).

merge(changeRequestId):
   a. Transition CR from 'approved' to 'merging'.
   b. Call mergeBranch({ remoteEnvId, branchName, targetBranch, workspacePath }).
   c. Update CR with merge_commit_sha.
   d. Transition CR to 'merged', set completed_at.
   e. Send progress: "Merged to {targetBranch}. Commit: {sha}"
   f. Call terminateRemote(remoteEnvId) for cleanup.

handleRejection(changeRequestId):
   a. CR already transitioned to 'rejected' by the API.
   b. Terminate remote env.
   c. Delete remote branch (best effort).
   d. Send progress: "Change rejected. Cleaned up."

cancel(changeRequestId):
   a. Transition to 'failed' with error 'Cancelled by user'.
   b. If remote_env_id set: terminate remote.
   c. Send progress: "Change request cancelled."
```

### Error Handling

- Each step is wrapped in try/catch.
- On any error: transition to 'failed' with the error message.
- If remote env was provisioned: terminate it (cleanup).
- The orchestrator NEVER throws — errors are captured in the CR record.
- Resume picks up from the last successful status (e.g., if 'implementing' failed, resume re-runs CC).

### Resume Logic

```
resume(crId):
  1. Fetch CR from DB
  2. Switch on cr.status:
     - 'pending' → start from provision step
     - 'provisioning' → check if remote_env exists and is ready; if yes skip to implement; if no re-provision
     - 'implementing' → check if remote still alive; if yes re-run CC; if no re-provision
     - 'deployed' → skip to await approval (re-send Slack message)
     - terminal states (merged, rejected, failed) → no-op, return
  3. For each step, check the associated resource (remote env, branch, preview) before re-creating
```

### Branch Name Generation

```typescript
// Generate a git-safe branch name from the change description
function generateBranchName(requestText: string): string {
  const slug = requestText
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')   // Replace non-alphanumeric with dashes
    .replace(/^-|-$/g, '')          // Trim leading/trailing dashes
    .slice(0, 50);                  // Limit length
  // Last 8 chars are random; first 8 are timestamp-encoded (same-second CRs get identical prefixes)
  const shortId = generateId().slice(-8);  // 8 random chars of ULID for uniqueness
  return `change/${slug}-${shortId}`;
}
```

### Lifecycle Enforcer Modification for CR-Linked Environments

Modify `packages/server/src/services/lifecycle-enforcer.ts`:
- In the idle check loop, skip environments where `remote_envs.change_request_id IS NOT NULL` and the linked change request is not in a terminal state (`merged`, `rejected`, `failed`).
- This prevents the lifecycle enforcer from terminating environments that are actively being used by an in-progress change request.
- Unit test: env with active CR (status = `implementing`) is not terminated on idle.
- Unit test: env with terminal CR (status = `merged`) is subject to normal idle termination.

### Tests

**`packages/core/src/__tests__/change-orchestrator.test.ts`** (with mocked deps):

1. Full happy path: pending → provisioning → implementing → deployed. CR has remote_env_id, session_id, branch_name, preview_url.
2. Provision failure: CR transitions to 'failed', remote env terminated.
3. CC failure (non-zero exit): CR transitions to 'failed' with stderr as error.
4. Merge happy path: approved → merging → merged. merge_commit_sha set, completed_at set, remote terminated.
5. Rejection: CR has status 'rejected', remote terminated, branch deleted.
6. Cancel during implementation: remote terminated, CR status 'failed'.
7. Resume from failed-at-implementing: re-runs CC (skips provisioning since remote exists).
8. Progress callbacks fired at each stage transition.
9. Branch name generation: "Add a loading spinner" → "change/add-a-loading-spinner-01jmf3xx".
10. Branch name handles special characters and long descriptions.
11. Concurrent execute calls for same CR: only one proceeds (optimistic locking).
12. Timeout during provisioning (>20 min): CR transitions to 'failed'.

## Relevant Files
- `packages/core/src/change-orchestrator.ts` (create)
- `packages/core/src/__tests__/change-orchestrator.test.ts` (create)
- `packages/core/src/index.ts` (modify — re-export)

### Known Limitation: In-Memory Orchestration

> Change request orchestration is in-memory. If the server restarts, in-progress orchestrations are lost. On server startup, query `change_requests` with non-terminal status (`pending`, `provisioning`, `implementing`, `deployed`, `approved`, `merging`) and call `resume()` for each to recover in-progress work. Add this startup recovery step to the server bootstrap sequence.

## Success Criteria
1. Orchestrator drives CR through full lifecycle: pending → provisioning → implementing → deployed.
2. Approve triggers: approved → merging → merged with cleanup.
3. Reject triggers cleanup: remote terminated, branch deleted.
4. Every failure transitions to 'failed' with descriptive error.
5. Remote environment is always cleaned up on completion (merged, rejected, or failed).
6. Progress callbacks fire at each stage transition.
7. Resume re-enters the workflow at the last known status.
8. Cancel terminates in-progress work and cleans up.
9. Branch names are git-safe, unique, and derived from request text.
10. Concurrent execution is safe (optimistic locking on CR status).
11. Orchestrator never throws — all errors captured in CR record.
