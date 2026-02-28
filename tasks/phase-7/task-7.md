# Task 7: CLI `changes` Commands

## Parallel Group: D

## Dependencies: Task 3

## Description

Add CLI commands for viewing and managing change requests. These provide visibility into the change request workflow outside of Slack.

### Commands

**`fuel-code changes`** — List change requests.

```
fuel-code changes [--status <status>] [--workspace <id>] [--limit <n>]

Change Requests:
  ID          Status        Request                         Branch                          Created
  01JMF3...   deployed      Add loading spinner to dash...  change/add-loading-spin-01jm..  2 hours ago
  01JMF2...   merged        Fix login redirect bug          change/fix-login-redirect-01..  5 hours ago
  01JMF1...   failed        Add dark mode support           change/add-dark-mode-sup-01j..  1 day ago

3 change requests (1 active, 1 merged, 1 failed)
```

**`fuel-code change <id>`** — Show change request detail.

```
fuel-code change 01JMF3...

Change Request: 01JMF3...
  Status:      deployed (awaiting approval)
  Request:     Add a loading spinner to the dashboard
  Requester:   John (via Slack)
  Workspace:   github.com/user/project
  Branch:      change/add-loading-spinner-01jmf3xx
  Preview:     http://54.123.45.67:3000
  Remote Env:  01JMF4... (t3.xlarge, running)
  Session:     01JMF5... (8 min, 47 messages)
  Created:     2026-02-18T10:30:00Z (2 hours ago)
  Cost:        ~$0.34

  Timeline:
    10:30:00  Created from Slack message
    10:30:15  Provisioning environment...
    10:35:22  Environment ready
    10:35:30  Claude implementing change...
    10:43:18  Implementation complete
    10:43:25  Preview deployed: http://54.123.45.67:3000
```

**`fuel-code change <id> --approve`** — Approve from CLI (alternative to Slack button).

```
fuel-code change 01JMF3... --approve

Approved change request 01JMF3.... Merging to main...
  Merged! Commit: abc1234
  Remote environment terminated.
```

**`fuel-code change <id> --reject`** — Reject from CLI.

```
fuel-code change 01JMF3... --reject

Rejected change request 01JMF3....
  Remote environment terminated.
  Branch deleted.
```

**`fuel-code change <id> --cancel`** — Cancel from CLI.

**`fuel-code change <id> --retry`** — Retry a failed change request.

### Files to Create

**`packages/cli/src/commands/changes.ts`**:

```typescript
import { Command } from 'commander';

export function registerChangesCommands(program: Command, apiClient: ApiClient) {
  // fuel-code changes — list
  program
    .command('changes')
    .description('List change requests')
    .option('--status <status>', 'Filter by status (comma-separated)')
    .option('--workspace <id>', 'Filter by workspace ID')
    .option('--limit <n>', 'Max results', '20')
    .option('--json', 'Output as JSON')
    .action(async (opts) => {
      const result = await apiClient.listChangeRequests({
        status: opts.status?.split(','),
        workspace_id: opts.workspace,
        limit: parseInt(opts.limit),
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }

      // Format as table with columns: ID, Status, Request, Branch, Created
      printChangeRequestsTable(result.change_requests);
    });

  // fuel-code change <id> — detail + actions
  program
    .command('change <id>')
    .description('Show change request detail or take action')
    .option('--approve', 'Approve the change request')
    .option('--reject', 'Reject the change request')
    .option('--cancel', 'Cancel the change request')
    .option('--retry', 'Retry a failed change request')
    .option('--json', 'Output as JSON')
    .action(async (id, opts) => {
      if (opts.approve) {
        await handleApprove(apiClient, id);
      } else if (opts.reject) {
        await handleReject(apiClient, id);
      } else if (opts.cancel) {
        await handleCancel(apiClient, id);
      } else if (opts.retry) {
        await handleRetry(apiClient, id);
      } else {
        await showChangeRequestDetail(apiClient, id, opts);
      }
    });
}
```

### API Client Extension

**Modify `packages/cli/src/lib/api-client.ts`**:

Add methods:
```typescript
// Change request API methods
async listChangeRequests(filters?: {
  status?: string[];
  workspace_id?: string;
  limit?: number;
  cursor?: string;
}): Promise<{ change_requests: ChangeRequest[]; next_cursor: string | null; has_more: boolean }>;

async getChangeRequest(id: string): Promise<ChangeRequest>;

async approveChangeRequest(id: string): Promise<ChangeRequest>;

async rejectChangeRequest(id: string): Promise<ChangeRequest>;

async cancelChangeRequest(id: string): Promise<ChangeRequest>;

async retryChangeRequest(id: string): Promise<ChangeRequest>;
```

### Output Formatting

Reuse existing formatting utilities from Phase 4 CLI (colors, table formatting, duration formatting):
- Status colors: pending=gray, provisioning/implementing=yellow, deployed=blue, merged=green, rejected/failed=red
- Truncate long request text and branch names in table view
- Show relative timestamps ("2 hours ago")
- Cost estimation from duration x instance cost rate

### Tests

**`packages/cli/src/commands/__tests__/changes.test.ts`**:

1. `fuel-code changes` lists change requests in table format.
2. `fuel-code changes --status deployed` filters correctly.
3. `fuel-code changes --json` outputs JSON.
4. `fuel-code change <id>` shows full detail with timeline.
5. `fuel-code change <id> --json` outputs JSON detail.
6. `fuel-code change <id> --approve` on deployed CR: approves and prints merge result.
7. `fuel-code change <id> --approve` on non-deployed CR: prints error.
8. `fuel-code change <id> --reject` on deployed CR: rejects and prints cleanup.
9. `fuel-code change <id> --cancel` on active CR: cancels.
10. `fuel-code change <id> --retry` on failed CR: retries.
11. Non-existent change request ID: prints "not found" error.

## Relevant Files
- `packages/cli/src/commands/changes.ts` (create)
- `packages/cli/src/lib/api-client.ts` (modify — add change request methods)
- `packages/cli/src/index.ts` (modify — register changes commands)
- `packages/cli/src/commands/__tests__/changes.test.ts` (create)

## Success Criteria
1. `fuel-code changes` lists change requests in a formatted table.
2. Filtering by status and workspace works.
3. `fuel-code change <id>` shows full detail including timeline and cost.
4. `--approve`, `--reject`, `--cancel`, `--retry` actions work from CLI.
5. Actions return appropriate success/error messages.
6. `--json` flag outputs structured JSON for both list and detail.
7. Status-specific colors in terminal output.
8. All commands require API connectivity (no offline mode for changes).
