-- Track git hook prompt state per workspace-device pair.
-- pending_git_hooks_prompt: true when we should prompt user next interactive session.
-- git_hooks_prompted: true after user has been prompted (regardless of answer).
-- This prevents repeated prompting — once prompted, we never ask again.

ALTER TABLE workspace_devices
ADD COLUMN IF NOT EXISTS pending_git_hooks_prompt BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE workspace_devices
ADD COLUMN IF NOT EXISTS git_hooks_prompted BOOLEAN NOT NULL DEFAULT false;
