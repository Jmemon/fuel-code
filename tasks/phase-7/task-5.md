# Task 5: Preview URL Construction + App Runner

## Parallel Group: C

## Dependencies: Task 3

## Description

Build the module that starts the application on a remote environment and constructs the publicly-accessible preview URL. After Claude Code implements the change and pushes the branch, the orchestrator calls this module to make the change reviewable.

The approach is simple: the remote EC2 instance already has a public IP and the code is already there. Just start the app and expose it on the configured port.

### Files to Create

**`packages/server/src/services/preview-runner.ts`**:

> **Architecture note:** All I/O is injected via interfaces. `SshExecutor` (from Task 4) handles remote command execution. `PortOpener` interface abstracts EC2 security group changes — its implementation lives in `packages/server/src/services/port-opener.ts` and delegates to the `Ec2Operations` interface from Phase 5.

```typescript
// PortOpener interface — defined in packages/core/src/interfaces/port-opener.ts
// Abstracts security group ingress rule changes for preview ports.
export interface PortOpener {
  openPort(params: { securityGroupId: string; port: number; cidr: string }): Promise<void>;
}

export interface PreviewRunnerConfig {
  // SSH connection (same as headless-cc)
  sshKeyPath: string;
  remoteHost: string;
  remoteUser: string;
  sshPort: number;

  // App config
  workspacePath: string;       // Path to repo on remote
  port: number;                // Port to expose (from CR's preview_port, default 3000)
  startCommand?: string;       // Optional override (auto-detected if not specified)

  // Timeouts
  sshTimeoutMs: number;        // SSH timeout (default: 30_000)
  startupTimeoutMs: number;    // Time to wait for app to start (default: 60_000)

  // Injected dependencies
  sshExecutor: SshExecutor;    // Injected at call site from packages/server/
  portOpener: PortOpener;      // Injected at call site from packages/server/
  logger: pino.Logger;
}

export interface PreviewResult {
  success: boolean;
  url: string | null;          // http://{publicIp}:{port}
  error?: string;
}

// Start the application on the remote and return the preview URL.
// The app runs as a detached background process on the remote.
export async function startPreview(config: PreviewRunnerConfig): Promise<PreviewResult>;
```

### App Start Command Detection

If `startCommand` is not provided, auto-detect from the project:

```typescript
async function detectStartCommand(sshExec: SshExecFn, workspacePath: string): Promise<string> {
  // Check package.json for start/dev scripts
  const pkgJson = await sshExec(
    `cat ${workspacePath}/package.json 2>/dev/null || echo "{}"`
  );
  const pkg = JSON.parse(pkgJson.stdout);

  // NOTE: Detection should use the package manager from the blueprint.
  // The remote environment uses bun.
  if (pkg.scripts?.dev) return `cd ${workspacePath} && bun run dev`;
  if (pkg.scripts?.start) return `cd ${workspacePath} && bun start`;

  // Check for common frameworks
  const files = await sshExec(`ls ${workspacePath}`);
  if (files.stdout.includes('next.config')) return `cd ${workspacePath} && bunx next dev -p ${port}`;
  if (files.stdout.includes('vite.config')) return `cd ${workspacePath} && bunx vite --host 0.0.0.0 --port ${port}`;

  // Fallback: try bun start
  return `cd ${workspacePath} && bun start`;
}
```

### Execution Flow

```
startPreview(config):

1. DETECT start command (if not specified):
   detectStartCommand() → startCmd

2. ENSURE port is open:
   sshExec(`lsof -i :${port} | grep LISTEN || true`)
   If port in use: kill existing process or return error

3. START the app as a background process:
   sshExec(`nohup ${startCmd} > /tmp/preview.log 2>&1 &`)
   The app runs detached — survives SSH disconnection.

4. WAIT for app to be reachable:
   Poll with retry (every 2s, up to startupTimeoutMs):
     sshExec(`curl -s -o /dev/null -w '%{http_code}' http://localhost:${port}/ || echo "000"`)
   If 200/301/302/304: app is ready.
   If timeout: return { success: false, error: 'App did not start within timeout' }

5. CONSTRUCT URL:
   url = `http://${config.remoteHost}:${port}`

6. VERIFY external accessibility:
   Attempt HTTP GET to the constructed URL from the server (not remote).
   If unreachable: check security group has the port open.
   Note: This verification may not work from Railway — skip if behind NAT.

7. RETURN:
   { success: true, url }
```

### Security Group Port Opening

The remote env's security group (from Phase 5) only allows SSH (port 22) by default. The preview port needs to be opened:

```typescript
// Before starting the app, ensure the preview port is accessible
// This calls the EC2 client to add an ingress rule for the preview port
// Depends on Phase 5 Task 3's `Ec2Operations` interface exposing
// `authorizeSecurityGroupIngress(params: { groupId: string, port: number, cidr: string }): Promise<void>`.
// The PortOpener implementation delegates to this method.
async function openPreviewPort(ec2Client: Ec2Operations, securityGroupId: string, port: number): Promise<void> {
  await ec2Client.authorizeSecurityGroupIngress({
    GroupId: securityGroupId,
    IpPermissions: [{
      IpProtocol: 'tcp',
      FromPort: port,
      ToPort: port,
      IpRanges: [{ CidrIp: '0.0.0.0/0', Description: 'fuel-code preview access' }],
    }],
  });
}
```

### Tests

**`packages/server/src/services/__tests__/preview-runner.test.ts`** (with mocked SshExecutor and PortOpener):

1. Happy path: app starts, becomes reachable, URL returned.
2. Start command auto-detection from package.json `dev` script.
3. Start command auto-detection from package.json `start` script.
4. Start command auto-detection for Next.js project.
5. Explicit start command overrides auto-detection.
6. App doesn't start within timeout: returns { success: false }.
7. Port already in use: existing process killed, app started.
8. URL format: `http://{publicIp}:{port}`.
9. Security group ingress rule added for preview port.

## Relevant Files
- `packages/core/src/interfaces/port-opener.ts` (create — PortOpener interface)
- `packages/server/src/services/preview-runner.ts` (create)
- `packages/server/src/services/port-opener.ts` (create — PortOpener implementation delegating to Ec2Operations)
- `packages/server/src/services/__tests__/preview-runner.test.ts` (create)

## Success Criteria
1. App is started as a detached background process on the remote.
2. Start command is auto-detected from package.json or framework config files.
3. Explicit start command override works.
4. Preview URL uses the EC2 public IP and configured port.
5. App reachability is verified before returning success.
6. Timeout returns failure if app doesn't start.
7. Security group is updated to allow ingress on the preview port.
8. Preview survives SSH disconnection (nohup + background).
