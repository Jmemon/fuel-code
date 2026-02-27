# Task 12: `fuel-code remote ssh`

## Parallel Group: D

## Dependencies: Task 6

## Description

Implement the `fuel-code remote ssh` command that connects the user to a remote environment via SSH. The command resolves the remote env by ID (with prefix matching), downloads or uses the cached SSH key, authorizes the user's IP on the security group, and opens an interactive SSH session by shelling out to the system `ssh` binary via `Bun.spawn`.

### Command Flow

```
$ fuel-code remote ssh <id>

1. RESOLVE REMOTE ENV
   ├── If <id> is a full ULID: use directly
   ├── If <id> is a prefix: GET /api/remote, find unique match
   ├── If no <id> and exactly 1 active env: use that one
   └── If no <id> and multiple active: list them, ask user to specify

2. FETCH DETAIL
   ├── GET /api/remote/:id
   ├── Check status is 'ready', 'active', or 'idle'
   └── Error messages for other states:
       - provisioning: "Still provisioning. Try again in a moment or check `fuel-code remote ls`."
       - terminated: "Environment has been terminated."
       - error: "Environment failed to provision."

3. GET SSH KEY
   ├── Check local cache: ~/.fuel-code/ssh-keys/{id}/id_ed25519
   │   └── If exists: use cached key
   ├── If not cached: GET /api/remote/:id/ssh-key
   │   ├── On 200: save to ~/.fuel-code/ssh-keys/{id}/id_ed25519, chmod 600
   │   └── On 410 Gone: "SSH key already downloaded and not cached locally.
   │                       Terminate and re-provision the environment."
   └── Verify key file has 0600 permissions

4. AUTHORIZE IP
   ├── Determine user's public IP via https://checkip.amazonaws.com
   └── POST /api/remote/:id/authorize-ip with { ip }

5. SSH CONNECT
   ├── Build command:
   │     ssh -i ~/.fuel-code/ssh-keys/{id}/id_ed25519 \
   │         -t \
   │         -o StrictHostKeyChecking=no \
   │         -o UserKnownHostsFile=/dev/null \
   │         -p 22 \
   │         ec2-user@{public_ip} \
   │         "docker exec -it fuel-code-remote bash -c 'cd /workspace && exec bash -l'"
   ├── Spawn via Bun.spawn with stdio: 'inherit' (interactive terminal)
   └── The -t flag forces PTY allocation for docker exec -it

6. AFTER DISCONNECT
   └── Print "Disconnected from remote environment {id}."
```

### ID Prefix Matching

```typescript
// Resolve a potentially-short ID to a full remote env ID
async function resolveRemoteEnvId(
  apiClient: ApiClient,
  idOrPrefix: string | undefined,
): Promise<string> {
  if (!idOrPrefix) {
    // No ID given — auto-select if exactly one active
    const { remote_envs } = await apiClient.getRemoteEnvs({ status: 'active,ready,idle' });
    if (remote_envs.length === 0) throw new Error('No active remote environments.');
    if (remote_envs.length === 1) return remote_envs[0].id;
    // Multiple — list and ask
    console.log('Multiple active environments:');
    for (const env of remote_envs) {
      console.log(`  ${env.id.slice(0, 8)}  ${env.workspace_display_name}  ${env.status}`);
    }
    throw new Error('Specify an environment ID: fuel-code remote ssh <id>');
  }

  if (idOrPrefix.length === 26) return idOrPrefix; // full ULID

  // Prefix match
  const { remote_envs } = await apiClient.getRemoteEnvs();
  const matches = remote_envs.filter(e => e.id.startsWith(idOrPrefix));
  if (matches.length === 0) throw new Error(`No remote environment matching "${idOrPrefix}".`);
  if (matches.length === 1) return matches[0].id;
  throw new Error(`Multiple environments match "${idOrPrefix}". Be more specific.`);
}
```

### CLI Options

```typescript
remote
  .command('ssh [id]')
  .description('SSH into a remote dev environment')
  .option('--port <port>', 'Forward a local port (-L port:localhost:port)', parseInt)
  .option('--command <cmd>', 'Run a command instead of interactive shell')
  .action(remoteSshAction);
```

- `--port <port>`: adds `-L {port}:localhost:{port}` to the SSH command for port forwarding.
- `--command <cmd>`: replaces the interactive docker exec with: `ssh ... ec2-user@ip "docker exec fuel-code-remote bash -c '{cmd}'"`.

### Relevant Files

**Create:**
- `packages/cli/src/commands/remote-ssh.ts`
- `packages/cli/src/commands/__tests__/remote-ssh.test.ts`

**Modify:**
- `packages/cli/src/index.ts` — register `remote ssh` command

### Tests

`remote-ssh.test.ts` (bun:test, mocked ApiClient + mocked Bun.spawn):

1. With valid ID and ready env → downloads key, spawns SSH with correct args.
2. SSH command includes `-t`, `-o StrictHostKeyChecking=no`, `-o UserKnownHostsFile=/dev/null`.
3. SSH command targets correct user (`ec2-user`) and IP.
4. SSH command exec's into Docker container with `cd /workspace && exec bash -l`.
5. Key file created at `~/.fuel-code/ssh-keys/{id}/id_ed25519` with 0600 permissions.
6. Cached key reused on subsequent SSH connections (no API call for key download).
7. 410 Gone (key already downloaded) with cached key → uses cached key, no error.
8. 410 Gone without cached key → clear error message about re-provisioning.
9. No argument with one active remote → auto-selects it.
10. No argument with multiple actives → lists them and exits with error.
11. No argument with zero actives → prints "No active remote environments."
12. Remote env status=provisioning → clear "still provisioning" message.
13. Remote env status=terminated → clear "has been terminated" message.
14. ID prefix matching: `fuel-code remote ssh 01JM` matches full ID.
15. `--port 3000` → adds `-L 3000:localhost:3000` to SSH args.
16. `--command "ls -la"` → runs command instead of interactive bash.
17. User's public IP is authorized via `POST /api/remote/:id/authorize-ip` before SSH.
18. "Disconnected from..." message printed after SSH exits.

### Success Criteria

1. `fuel-code remote ssh <id>` connects to the remote environment's Docker container.
2. User lands in `/workspace` inside the container with a bash login shell.
3. SSH key is downloaded on first use, cached locally, and reused on subsequent connections.
4. Key file has 0600 permissions.
5. User's IP is authorized on the security group before connecting.
6. ID resolution supports full ULIDs, prefixes, and auto-selection.
7. Clear error messages for non-ready, terminated, unknown, and provisioning environments.
8. Port forwarding works with `--port` flag.
9. Single-command execution works with `--command` flag.
10. SSH session inherits the terminal (full interactive use via `stdio: 'inherit'`).
