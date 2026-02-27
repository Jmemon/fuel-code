# Task 6: Slack Bot (Bolt Framework)

## Parallel Group: D

## Dependencies: Tasks 2, 3

## Description

Build the Slack bot that serves as the user-facing entry point for change requests. The bot listens for mentions and DMs, creates change requests via the server API, posts progress updates as thread replies, and sends interactive Approve/Reject buttons when the preview is ready.

### Package Setup

Create `packages/slack/` as a new workspace package:

```bash
mkdir -p packages/slack/src
cd packages/slack && bun init
bun add @slack/bolt
```

> **Workspace registration:** Update root `package.json` `workspaces` array to include `"packages/slack"`. Also add `packages/slack` to `bunfig.toml` if workspace config lives there. This ensures `bun install` at the root resolves cross-package dependencies correctly.

**`packages/slack/package.json`**:
```json
{
  "name": "@fuel-code/slack",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": {
    "start": "bun run src/index.ts",
    "dev": "bun --watch run src/index.ts"
  },
  "dependencies": {
    "@slack/bolt": "^4.1.0"
  }
}
```

### Files to Create

**`packages/slack/src/index.ts`** (Slack bot entry point):

```typescript
import { App, LogLevel } from '@slack/bolt';

// Configuration from environment variables
interface SlackBotConfig {
  slackBotToken: string;         // SLACK_BOT_TOKEN (xoxb-...)
  slackSigningSecret: string;    // SLACK_SIGNING_SECRET
  slackAppToken: string;         // SLACK_APP_TOKEN (xapp-...) for Socket Mode
  fuelCodeApiUrl: string;        // FUEL_CODE_API_URL
  fuelCodeApiKey: string;        // FUEL_CODE_API_KEY
  allowedSlackUserIds: string[]; // ALLOWED_SLACK_USER_IDS (comma-separated)
  defaultWorkspaceId: string;    // DEFAULT_WORKSPACE_ID
  port?: number;                 // PORT for HTTP mode (default: 3001)
}

function loadConfig(): SlackBotConfig {
  // Load from env vars, validate required fields
}

// Create and start the Slack bot
async function main() {
  const config = loadConfig();

  const app = new App({
    token: config.slackBotToken,
    signingSecret: config.slackSigningSecret,
    appToken: config.slackAppToken,
    socketMode: true,            // Use Socket Mode for development
    logLevel: LogLevel.INFO,
  });

  // Register handlers
  registerMessageHandler(app, config);
  registerActionHandlers(app, config);

  await app.start(config.port || 3001);
  console.log('fuel-code Slack bot is running');
}

main();
```

**`packages/slack/src/handlers/message.ts`** (message handler):

```typescript
// Listen for @fuel-code-bot mentions and DMs with change descriptions
export function registerMessageHandler(app: App, config: SlackBotConfig) {
  // Handle app_mention events (when someone @mentions the bot)
  app.event('app_mention', async ({ event, say, client }) => {
    // 1. SECURITY: Verify the user is in the allowed list
    if (!config.allowedSlackUserIds.includes(event.user)) {
      await say({
        text: "Sorry, you're not authorized to create change requests.",
        thread_ts: event.ts,
      });
      return;
    }

    // 2. Extract the change description (remove the bot mention)
    const requestText = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();
    if (!requestText) {
      await say({
        text: "Please include a change description. Example: `@fuel-code-bot Add a loading spinner to the dashboard`",
        thread_ts: event.ts,
      });
      return;
    }

    // 3. Acknowledge in thread
    const ack = await say({
      text: `:rocket: Starting change request...\n> ${requestText}`,
      thread_ts: event.ts,
    });

    // 4. Create change request via fuel-code API
    try {
      const response = await fetch(`${config.fuelCodeApiUrl}/api/changes`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${config.fuelCodeApiKey}`,
        },
        body: JSON.stringify({
          workspace_id: config.defaultWorkspaceId,
          request_text: requestText,
          source: 'slack',
          requester_id: event.user,
          requester_name: await getUserName(client, event.user),
          slack_channel_id: event.channel,
          slack_thread_ts: event.ts,
          idempotency_key: event.event_ts,  // Slack event_ts as dedup key
        }),
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || `API returned ${response.status}`);
      }

      const { change_request, deduplicated } = await response.json();

      if (deduplicated) {
        await say({
          text: `This change request already exists (ID: ${change_request.id}). Status: ${change_request.status}`,
          thread_ts: event.ts,
        });
        return;
      }

      await say({
        text: `:hourglass_flowing_sand: Change request created (ID: \`${change_request.id}\`). Provisioning environment...`,
        thread_ts: event.ts,
      });

    } catch (error) {
      await say({
        text: `:x: Failed to create change request: ${error.message}`,
        thread_ts: event.ts,
      });
    }
  });
}

// Get Slack user's display name
async function getUserName(client: WebClient, userId: string): Promise<string> {
  try {
    const result = await client.users.info({ user: userId });
    return result.user?.real_name || result.user?.name || userId;
  } catch {
    return userId;
  }
}
```

**`packages/slack/src/handlers/actions.ts`** (interactive button handlers):

```typescript
// Handle Approve/Reject button clicks
export function registerActionHandlers(app: App, config: SlackBotConfig) {
  // Approve button
  app.action('change_approve', async ({ action, ack, body, client }) => {
    await ack();

    const changeRequestId = action.value;

    // Security check
    if (!config.allowedSlackUserIds.includes(body.user.id)) {
      await client.chat.postMessage({
        channel: body.channel.id,
        thread_ts: body.message.thread_ts,
        text: "You're not authorized to approve changes.",
      });
      return;
    }

    try {
      const response = await fetch(
        `${config.fuelCodeApiUrl}/api/changes/${changeRequestId}/approve`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.fuelCodeApiKey}` },
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || `API returned ${response.status}`);
      }

      // Update the message to show approved state
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: `:white_check_mark: **Approved** by <@${body.user.id}>. Merging...`,
        blocks: [],  // Remove the buttons
      });

    } catch (error) {
      await client.chat.postMessage({
        channel: body.channel.id,
        thread_ts: body.message.thread_ts,
        text: `:x: Failed to approve: ${error.message}`,
      });
    }
  });

  // Reject button
  app.action('change_reject', async ({ action, ack, body, client }) => {
    await ack();

    const changeRequestId = action.value;

    if (!config.allowedSlackUserIds.includes(body.user.id)) {
      await client.chat.postMessage({
        channel: body.channel.id,
        thread_ts: body.message.thread_ts,
        text: "You're not authorized to reject changes.",
      });
      return;
    }

    try {
      const response = await fetch(
        `${config.fuelCodeApiUrl}/api/changes/${changeRequestId}/reject`,
        {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${config.fuelCodeApiKey}` },
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || `API returned ${response.status}`);
      }

      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: `:no_entry_sign: **Rejected** by <@${body.user.id}>. Cleaning up...`,
        blocks: [],
      });

    } catch (error) {
      await client.chat.postMessage({
        channel: body.channel.id,
        thread_ts: body.message.thread_ts,
        text: `:x: Failed to reject: ${error.message}`,
      });
    }
  });
}
```

**`packages/slack/src/progress-updater.ts`** (progress thread updates):

```typescript
// The orchestrator calls onProgress at each stage transition.
// This module sends thread replies to Slack with the update.
// It also sends the interactive Approve/Reject message when deployed.

export interface SlackProgressUpdater {
  // Called by the orchestrator's onProgress callback
  sendUpdate(changeRequestId: string, status: string, message: string): Promise<void>;
}

export function createSlackProgressUpdater(deps: {
  slackClient: WebClient;
  fuelCodeApiUrl: string;
  fuelCodeApiKey: string;
}): SlackProgressUpdater {
  return {
    // NOTE: Pass `slack_channel_id` and `slack_thread_ts` directly to the progress
    // updater constructor or to each `sendUpdate()` call. The orchestrator already has
    // this data from initial CR creation — avoid unnecessary API round-trips.
    async sendUpdate(changeRequestId, status, message) {
      // Get CR to find slack_channel_id and slack_thread_ts
      const cr = await fetchChangeRequest(deps.fuelCodeApiUrl, deps.fuelCodeApiKey, changeRequestId);
      if (!cr?.slack_channel_id || !cr?.slack_thread_ts) return;

      // Map status to emoji + message
      const statusEmoji: Record<string, string> = {
        provisioning:  ':hourglass_flowing_sand:',
        implementing:  ':robot_face:',
        deployed:      ':eyes:',
        merging:       ':merge:',
        merged:        ':white_check_mark:',
        rejected:      ':no_entry_sign:',
        failed:        ':x:',
      };

      const emoji = statusEmoji[status] || ':information_source:';

      // Post thread reply
      await deps.slackClient.chat.postMessage({
        channel: cr.slack_channel_id,
        thread_ts: cr.slack_thread_ts,
        text: `${emoji} ${message}`,
      });

      // If deployed: send interactive Approve/Reject message
      if (status === 'deployed' && cr.preview_url) {
        const result = await deps.slackClient.chat.postMessage({
          channel: cr.slack_channel_id,
          thread_ts: cr.slack_thread_ts,
          text: `Preview ready: ${cr.preview_url}`,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `:eyes: *Preview ready*\n<${cr.preview_url}|Open Preview>\n\nEstimated cost so far: $\{costPerHour * uptimeHours} (use Phase 6 Task 3's cost lookup utility instead of hardcoded estimate)`,
              },
            },
            {
              type: 'actions',
              elements: [
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Approve & Merge' },
                  style: 'primary',
                  action_id: 'change_approve',
                  value: changeRequestId,
                },
                {
                  type: 'button',
                  text: { type: 'plain_text', text: 'Reject' },
                  style: 'danger',
                  action_id: 'change_reject',
                  value: changeRequestId,
                },
              ],
            },
          ],
        });

        // Store the interactive message timestamp for later updates
        await updateChangeRequest(deps.fuelCodeApiUrl, deps.fuelCodeApiKey, changeRequestId, {
          slack_message_ts: result.ts,
        });
      }
    },
  };
}
```

### Slack App Configuration

The Slack app needs these scopes and features:
- **Bot Token Scopes**: `app_mentions:read`, `chat:write`, `users:read`
- **Event Subscriptions**: `app_mention` event
- **Interactivity**: Enable for Approve/Reject buttons
- **Socket Mode**: Enable for development (no public URL needed)

### Environment Variables

```bash
# Slack credentials
SLACK_BOT_TOKEN=xoxb-...        # Bot User OAuth Token
SLACK_SIGNING_SECRET=...         # Signing Secret from App Settings
SLACK_APP_TOKEN=xapp-...         # App-Level Token for Socket Mode

# fuel-code connection
FUEL_CODE_API_URL=https://fuel-code.up.railway.app
FUEL_CODE_API_KEY=fc_...

# Security
ALLOWED_SLACK_USER_IDS=U0123456789  # Comma-separated
DEFAULT_WORKSPACE_ID=01JMF3...       # Default workspace for changes
```

### Tests

**`packages/slack/src/__tests__/message-handler.test.ts`**:

1. Authorized user mention with description: creates change request via API.
2. Unauthorized user mention: responds with "not authorized" (does not create CR).
3. Mention without description: responds with usage instructions.
4. Duplicate message (same event_ts): API returns deduplicated CR.
5. API error: responds with error message in thread.
6. Bot mention text is cleaned of the mention tag before being sent as request_text.

**`packages/slack/src/__tests__/action-handler.test.ts`**:

7. Approve button click: calls /api/changes/:id/approve, updates message.
8. Reject button click: calls /api/changes/:id/reject, updates message.
9. Unauthorized user clicks approve: responds with "not authorized".
10. API error on approve: posts error message in thread.

**`packages/slack/src/__tests__/progress-updater.test.ts`**:

11. Status update posts thread reply with correct emoji.
12. 'deployed' status posts interactive message with Approve/Reject buttons.
13. Interactive message includes preview URL.
14. Missing slack_channel_id: silently skips (no error).

## Relevant Files
- `packages/slack/package.json` (create)
- `packages/slack/src/index.ts` (create)
- `packages/slack/src/handlers/message.ts` (create)
- `packages/slack/src/handlers/actions.ts` (create)
- `packages/slack/src/progress-updater.ts` (create)
- `packages/slack/src/__tests__/message-handler.test.ts` (create)
- `packages/slack/src/__tests__/action-handler.test.ts` (create)
- `packages/slack/src/__tests__/progress-updater.test.ts` (create)

## Success Criteria
1. Bot responds to @mentions with change request creation.
2. Unauthorized users are rejected.
3. Progress updates appear as thread replies with appropriate emojis.
4. Interactive Approve/Reject buttons are sent when preview is deployed.
5. Approve button triggers merge via API.
6. Reject button triggers cleanup via API.
7. Duplicate messages (same event_ts) are deduplicated.
8. Socket Mode enables local development without a public URL.
9. All Slack user IDs are validated against the allowed list.
10. Bot gracefully handles API errors with descriptive thread replies.
