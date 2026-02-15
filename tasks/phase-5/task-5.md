# Task 5: User-Data Script + Dockerfile.remote + Template Renderer

## Parallel Group: A

## Dependencies: None

## Description

Implement the EC2 user-data bootstrap script, the reference Dockerfile, and the server-side template renderer. The user-data script is a bash template with `{{VARIABLE}}` placeholders that the provisioning orchestrator fills in at launch time. It runs on the EC2 instance at first boot and sets up everything: Docker, the project environment, fuel-code CLI, Claude Code, hooks, and calls back to the server when ready.

### User-Data Script: `infra/docker/scripts/user-data.sh`

The script runs as root on the Amazon Linux 2023 EC2 instance. Stages:

```bash
#!/bin/bash
set -euo pipefail

# ============================================================
# fuel-code remote environment bootstrap script
# Runs on EC2 first boot via user-data.
# Variables substituted at provisioning time by renderUserData().
# ============================================================

# Error handler — callback to backend on failure
trap 'on_error $LINENO' ERR

on_error() {
  local line=$1
  # Use IMDSv2 for metadata access
  TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
    -H "X-aws-ec2-metadata-token-ttl-seconds: 300" 2>/dev/null || echo "")
  INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
    http://169.254.169.254/latest/meta-data/instance-id 2>/dev/null || echo "unknown")
  curl -s -X POST "{{BACKEND_URL}}/api/remote/{{REMOTE_ENV_ID}}/error" \
    -H "Authorization: Bearer {{API_KEY}}" \
    -H "Content-Type: application/json" \
    -d "{\"error\": \"Bootstrap failed at line $line\", \"stage\": \"user-data\"}" \
    || true
  exit 1
}

# Step 1: Install Docker on Amazon Linux 2023
dnf update -y -q
dnf install -y -q docker git
systemctl start docker
systemctl enable docker

# Step 2: Configure SSH with the ephemeral public key
mkdir -p /home/ec2-user/.ssh
echo "{{SSH_PUBLIC_KEY}}" >> /home/ec2-user/.ssh/authorized_keys
chmod 600 /home/ec2-user/.ssh/authorized_keys
chown -R ec2-user:ec2-user /home/ec2-user/.ssh

# Step 3: Pull Docker image
docker pull {{DOCKER_IMAGE}}

# Step 4: Build port mapping flags
PORT_FLAGS=""
{{PORT_FLAG_LINES}}

# Step 5: Start container
docker run -d --name fuel-code-remote \
  {{ENV_FLAG_LINES}} \
  $PORT_FLAGS \
  -v /home/ec2-user/.ssh:/root/.ssh:ro \
  --restart unless-stopped \
  {{DOCKER_IMAGE}} \
  tail -f /dev/null

# Step 6: Inside container — install deps, clone repo, setup
docker exec fuel-code-remote bash -c '
  set -euo pipefail
  apt-get update -qq && apt-get install -y -qq git curl {{SYSTEM_DEPS}} openssh-client

  # Clone repo
  git clone {{REPO_URL}} /workspace
  cd /workspace
  git checkout {{REPO_BRANCH}}

  # Install bun (needed for fuel-code CLI)
  curl -fsSL https://bun.sh/install | bash
  export PATH="$HOME/.bun/bin:$PATH"

  # Run blueprint setup commands
  {{SETUP_COMMANDS}}

  # Install fuel-code CLI
  bun install -g fuel-code

  # Initialize fuel-code on this remote device
  fuel-code init --device-type remote --device-name "remote-{{REMOTE_ENV_ID}}" \
    --backend-url "$FUEL_CODE_BACKEND_URL" --api-key "$FUEL_CODE_API_KEY"

  # Install Claude Code
  bun install -g @anthropic-ai/claude-code || npm install -g @anthropic-ai/claude-code || true

  # Install hooks
  fuel-code hooks install

  # Health check
  claude --version || echo "WARNING: Claude Code not available"
'

# Step 7: Callback to backend — environment ready
TOKEN=$(curl -s -X PUT "http://169.254.169.254/latest/api/token" \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 300")
INSTANCE_ID=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/instance-id)
PUBLIC_IP=$(curl -s -H "X-aws-ec2-metadata-token: $TOKEN" \
  http://169.254.169.254/latest/meta-data/public-ipv4)
DEVICE_ID=$(docker exec fuel-code-remote bash -c \
  'cat /root/.fuel-code/config.yaml 2>/dev/null | grep "device_id:" | head -1 | awk "{print \$2}"' \
  || echo "")

curl -s -X POST "{{BACKEND_URL}}/api/remote/{{REMOTE_ENV_ID}}/ready" \
  -H "Authorization: Bearer {{API_KEY}}" \
  -H "Content-Type: application/json" \
  -d "{
    \"instance_id\": \"$INSTANCE_ID\",
    \"public_ip\": \"$PUBLIC_IP\",
    \"ssh_port\": 22,
    \"device_id\": \"$DEVICE_ID\"
  }"

echo "fuel-code remote environment ready"
```

### Template Renderer: `packages/server/src/aws/user-data.ts`

```typescript
export interface UserDataParams {
  remoteEnvId: string;
  dockerImage: string;
  repoUrl: string;
  repoBranch: string;
  setupCommands: string[];       // from blueprint.setup
  environment: Record<string, string>;  // from blueprint.environment
  ports: number[];               // from blueprint.ports
  backendUrl: string;
  apiKey: string;
  anthropicApiKey: string;
  sshPublicKey: string;
  systemDeps: string[];          // from blueprint.system_deps
}

// Read the user-data.sh template, substitute all {{VARIABLE}} placeholders.
// Validates no unreplaced {{...}} remain.
// Returns the script as a string (caller base64-encodes for EC2).
export function renderUserData(params: UserDataParams): string;
```

Rendering details:
- `{{PORT_FLAG_LINES}}` → for each port: `PORT_FLAGS="$PORT_FLAGS -p {port}:{port}"`
- `{{ENV_FLAG_LINES}}` → for each env var: `-e {KEY}={VALUE}`, plus always: `-e ANTHROPIC_API_KEY={{ANTHROPIC_API_KEY}}`, `-e FUEL_CODE_BACKEND_URL={{BACKEND_URL}}`, `-e FUEL_CODE_API_KEY={{API_KEY}}`, `-e FUEL_CODE_REMOTE_ENV_ID={{REMOTE_ENV_ID}}`
- `{{SETUP_COMMANDS}}` → newline-joined setup commands (each on its own line)
- `{{SYSTEM_DEPS}}` → space-separated package names
- Shell-special characters in values must be escaped (single quotes → `'\''`)

### Dockerfile.remote: `infra/docker/Dockerfile.remote`

A reference Dockerfile for users who want to pre-build a base image. NOT used by the default provisioning flow (which uses the blueprint's `docker.base_image` directly).

```dockerfile
# Reference base image for fuel-code remote dev environments
# Use: docker build -t fuel-code-remote -f Dockerfile.remote .
# The default provisioning flow pulls the blueprint's base_image directly.
FROM node:22-bookworm

# Common dev tools
RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl wget vim jq openssh-client build-essential \
    && rm -rf /var/lib/apt/lists/*

# Install bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /workspace

CMD ["tail", "-f", "/dev/null"]
```

### Relevant Files

**Create/Replace:**
- `infra/docker/scripts/user-data.sh` (replace placeholder)
- `infra/docker/Dockerfile.remote` (replace placeholder)
- `packages/server/src/aws/user-data.ts` (template renderer)
- `packages/server/src/aws/__tests__/user-data.test.ts`

### Tests

`user-data.test.ts` (bun:test):

1. `renderUserData` replaces all `{{VARIABLE}}` placeholders with actual values.
2. `renderUserData` throws if any `{{...}}` placeholder remains unreplaced.
3. Port flags generated correctly for multiple ports (e.g., ports [3000, 5432] → two `-p` lines).
4. Empty ports array → no port flag lines.
5. Environment variables rendered as `-e KEY=VALUE` flags.
6. Default env vars always present: ANTHROPIC_API_KEY, FUEL_CODE_BACKEND_URL, FUEL_CODE_API_KEY, FUEL_CODE_REMOTE_ENV_ID.
7. Setup commands joined with newlines, each on its own line.
8. Empty setup commands → no setup section (just a comment or empty string).
9. System deps space-separated in the `apt-get install` command.
10. Empty system deps → `apt-get install` only has the always-present packages (git, curl, openssh-client).
11. Special characters in environment values are escaped (single quotes, backticks, dollar signs).
12. Git branch with slashes (e.g., `feature/my-branch`) is handled correctly.
13. The rendered script is valid bash — no unmatched quotes or syntax errors from substitution.
14. IMDSv2 token is used for all metadata access (security best practice on AL2023).

### Success Criteria

1. User-data script installs Docker, pulls the image, starts container, clones repo, runs setup, installs fuel-code + Claude Code, and calls ready callback.
2. All placeholder variables are documented in the template header comment.
3. `renderUserData` replaces all placeholders and throws if any `{{...}}` remains.
4. Error handling in the script calls the error callback endpoint with failure details and line number.
5. Script uses IMDSv2 token for metadata access.
6. Dockerfile.remote provides a usable reference base image with common dev tools.
7. Port mappings, env vars, and setup commands are correctly rendered from blueprint config.
8. Shell injection is prevented by proper escaping of values.
