# Task 8: Provisioning Orchestrator (Full Pipeline)

## Parallel Group: C

## Dependencies: Tasks 3, 4, 5, 6

## Description

Build the provisioning orchestrator — the core state machine that coordinates the multi-step provisioning flow. It generates SSH keys, ensures the security group, renders the user-data script, launches the EC2 instance, tags it, and updates the remote_env record. The orchestrator tracks progress through named stages for precise rollback on failure.

This is a server-side service called by the `POST /api/remote` handler. After creating the DB record and responding 202, the handler calls the orchestrator asynchronously (fire-and-forget with error logging).

### Interface

```typescript
// packages/server/src/services/provisioner.ts

export interface ProvisionerDeps {
  ec2Client: Ec2Operations;
  sshKeyManager: SshKeyManager;
  sql: postgres.Sql;
  logger: pino.Logger;
  config: {
    backendUrl: string;
    apiKey: string;
    anthropicApiKey: string;
  };
}

// Provision a new remote environment. Runs all stages, updates DB throughout.
// On failure at any stage, rolls back and sets status to 'error'.
export async function provisionRemoteEnv(
  deps: ProvisionerDeps,
  remoteEnvId: string,
  params: ProvisionParams,
): Promise<void>;

// Terminate a remote environment. Full cleanup: EC2, SSH keys, DB, event.
export async function terminateRemoteEnv(
  deps: ProvisionerDeps,
  remoteEnvId: string,
  reason: string,
): Promise<void>;

export interface ProvisionParams {
  workspaceId: string;
  blueprint: FrozenBlueprint;
  repoUrl: string;
  repoBranch: string;
  callerIp: string;       // from req.ip or x-forwarded-for, for security group
}

// Stage tracking for precise rollback
type ProvisioningStage =
  | 'INIT'
  | 'KEYS_GENERATED'
  | 'KEYS_UPLOADED'
  | 'SG_READY'
  | 'INSTANCE_LAUNCHED'
  | 'TAGGED'
  | 'DONE';
```

### Provisioning Sequence

```
provisionRemoteEnv(deps, remoteEnvId, params):

  stage = 'INIT'
  let instanceId: string | null = null;
  let keysUploaded = false;

  try {
    // 1. Emit remote.provision.start event
    await emitEvent(deps, 'remote.provision.start', { remote_env_id: remoteEnvId });

    // 2. Generate SSH key pair
    const keyPair = await deps.sshKeyManager.generateKeyPair(remoteEnvId);
    stage = 'KEYS_GENERATED';

    // 3. Upload SSH keys to S3
    const s3KeyPrefix = await deps.sshKeyManager.uploadKeyPair(remoteEnvId, keyPair);
    keysUploaded = true;
    stage = 'KEYS_UPLOADED';
    // Update DB with S3 key path
    await updateRemoteEnvField(deps.sql, remoteEnvId, { ssh_key_s3_key: s3KeyPrefix });

    // 4. Ensure security group exists + authorize caller IP
    const sgId = await deps.ec2Client.ensureSecurityGroup();
    await deps.ec2Client.authorizeIngress(sgId, params.callerIp);
    stage = 'SG_READY';

    // 5. Get latest Amazon Linux 2023 AMI
    const amiId = await deps.ec2Client.getLatestAmiId();

    // 6. Render user-data script
    const userDataScript = renderUserData({
      remoteEnvId,
      dockerImage: params.blueprint.config.docker.base_image,
      repoUrl: params.repoUrl,
      repoBranch: params.repoBranch,
      setupCommands: params.blueprint.config.setup,
      environment: params.blueprint.config.environment || {},
      ports: params.blueprint.config.ports || [],
      backendUrl: deps.config.backendUrl,
      apiKey: deps.config.apiKey,
      anthropicApiKey: deps.config.anthropicApiKey,
      sshPublicKey: keyPair.publicKey,
      systemDeps: params.blueprint.config.system_deps || [],
    });
    const userDataBase64 = Buffer.from(userDataScript).toString('base64');

    // 7. Launch EC2 instance
    const { instanceId: id } = await deps.ec2Client.launchInstance({
      instanceType: params.blueprint.config.resources.instance_type,
      amiId,
      securityGroupId: sgId,
      userData: userDataBase64,
      diskGb: params.blueprint.config.resources.disk_gb,
      tags: {
        [EC2_TAGS.MANAGED.key]: EC2_TAGS.MANAGED.value,
        'fuel-code:remote-env-id': remoteEnvId,
        'fuel-code:workspace': params.workspaceId,
        'Name': `fuel-code-remote-${remoteEnvId}`,
      },
    });
    instanceId = id;
    stage = 'INSTANCE_LAUNCHED';

    // 8. Update DB with instance_id
    await updateRemoteEnvInstance(deps.sql, remoteEnvId, instanceId);

    // 9. Wait for instance to reach 'running' state
    const instanceInfo = await deps.ec2Client.waitForRunning(instanceId, 120_000);

    // 10. Update DB with public IP (from running instance)
    if (instanceInfo.publicIp) {
      await updateRemoteEnvField(deps.sql, remoteEnvId, { public_ip: instanceInfo.publicIp });
    }

    stage = 'DONE';
    // The user-data script will call POST /api/remote/:id/ready when Docker setup completes.

  } catch (error) {
    // Rollback based on which stage was reached
    await rollback(deps, remoteEnvId, stage, instanceId, keysUploaded, error);
  }
```

### Rollback Logic

```typescript
async function rollback(
  deps: ProvisionerDeps,
  remoteEnvId: string,
  stage: ProvisioningStage,
  instanceId: string | null,
  keysUploaded: boolean,
  error: unknown,
): Promise<void> {
  deps.logger.error({ remoteEnvId, stage, error }, 'Provisioning failed, rolling back');

  // Best-effort cleanup — each step wrapped in try/catch
  if (instanceId && stage >= 'INSTANCE_LAUNCHED') {
    try { await deps.ec2Client.terminateInstance(instanceId); }
    catch (e) { deps.logger.error({ instanceId, error: e }, 'Failed to terminate instance during rollback'); }
  }

  if (keysUploaded) {
    try { await deps.sshKeyManager.deleteKeyPair(remoteEnvId); }
    catch (e) { deps.logger.error({ remoteEnvId, error: e }, 'Failed to delete SSH keys during rollback'); }
  }

  // Update DB status to 'error'
  const errorMessage = error instanceof Error ? error.message : String(error);
  await updateRemoteEnvStatus(deps.sql, remoteEnvId, 'error', {
    metadata: { error: errorMessage, failed_at_stage: stage },
  });

  // Emit error event
  await emitEvent(deps, 'remote.provision.error', {
    remote_env_id: remoteEnvId,
    error: errorMessage,
    stage,
  });
}
```

### Terminate Function

```typescript
async function terminateRemoteEnv(
  deps: ProvisionerDeps,
  remoteEnvId: string,
  reason: string,
): Promise<void> {
  const env = await getRemoteEnv(deps.sql, remoteEnvId);
  if (!env) throw new NotFoundError(`Remote environment ${remoteEnvId} not found`);

  // 1. Terminate EC2 instance (if one was launched)
  if (env.instance_id) {
    await deps.ec2Client.terminateInstance(env.instance_id);
  }

  // 2. Delete SSH keys from S3
  await deps.sshKeyManager.deleteKeyPair(remoteEnvId);

  // 3. Compute cost
  const uptimeMs = env.ready_at
    ? Date.now() - new Date(env.ready_at).getTime()
    : 0;
  const uptimeHours = uptimeMs / 3_600_000;
  const totalCost = uptimeHours * (env.cost_per_hour_usd || 0);

  // 4. Update DB
  await updateRemoteEnvStatus(deps.sql, remoteEnvId, 'terminated', {
    terminated_at: new Date().toISOString(),
    termination_reason: reason,
    total_cost_usd: totalCost,
  });

  // 5. Emit terminate event
  await emitEvent(deps, 'remote.terminate', {
    remote_env_id: remoteEnvId,
    instance_id: env.instance_id,
    reason,
    uptime_seconds: Math.floor(uptimeMs / 1000),
    total_cost_usd: totalCost,
  });
}
```

### Wiring into POST /api/remote

In `packages/server/src/routes/remote.ts`, the POST handler calls the orchestrator after responding:

```typescript
router.post('/', async (req, res) => {
  // ... validate body, create DB record ...
  res.status(202).json({ id: remoteEnvId, status: 'provisioning' });

  // Fire-and-forget — errors logged by the orchestrator
  provisionRemoteEnv(deps, remoteEnvId, {
    workspaceId: body.workspace_id,
    blueprint: frozenBlueprint,
    repoUrl: body.repo_url,
    repoBranch: body.repo_branch,
    callerIp: req.ip || req.headers['x-forwarded-for'] as string,
  }).catch(err => deps.logger.error({ remoteEnvId, err }, 'Provisioning failed'));
});
```

### Relevant Files

**Create:**
- `packages/server/src/services/provisioner.ts`
- `packages/server/src/services/__tests__/provisioner.test.ts`

**Modify:**
- `packages/server/src/routes/remote.ts` — wire orchestrator into POST handler, wire `terminateRemoteEnv` into POST /:id/terminate handler

### Tests

`provisioner.test.ts` (bun:test, all AWS mocked via MockEc2Client):

1. Full provision flow: generates keys, uploads to S3, ensures SG, authorizes IP, launches EC2, tags instance, updates DB.
2. Remote_env record has instance_id and public_ip after successful provisioning.
3. `remote.provision.start` event emitted at the beginning.
4. EC2 instance is tagged with `fuel-code:managed=true`, `fuel-code:remote-env-id`, and `Name`.
5. User-data script is rendered with correct variables from blueprint.
6. **Failure at SSH key generation**: status set to error, no EC2 launch attempted.
7. **Failure at S3 upload**: status set to error, no EC2 launch, temp keys cleaned up.
8. **Failure at SG creation**: status set to error, SSH keys deleted from S3.
9. **Failure at EC2 launch**: status set to error, SSH keys deleted from S3.
10. **Failure at waitForRunning (timeout)**: instance terminated, SSH keys deleted, status set to error.
11. `remote.provision.error` event emitted on any failure with correct stage.
12. `terminateRemoteEnv` calls EC2 terminate, deletes SSH keys, updates DB, emits event.
13. `terminateRemoteEnv` computes cost correctly (uptime * cost_per_hour).
14. `terminateRemoteEnv` handles missing instance_id gracefully (env never fully launched).
15. Orchestrator does not block the API response (fire-and-forget pattern).

### Success Criteria

1. Orchestrator executes all provisioning steps in sequence.
2. On success, remote_env record has instance_id, public_ip, ssh_key_s3_key populated.
3. On failure at any step, status is `error` with descriptive message and stage info.
4. Rollback is precise: only resources created up to the failure point are cleaned up.
5. `remote.provision.start` and `remote.provision.error` events are emitted correctly.
6. `terminateRemoteEnv` performs complete cleanup (EC2 + SSH keys + DB + event).
7. Instance is tagged with fuel-code metadata for orphan detection.
8. Orchestrator runs asynchronously, does not block the API response.
9. All tests pass with mock EC2 client — no real AWS calls.
