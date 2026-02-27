# Task 11: Cost Estimation in Blueprint + Remote Output

## Parallel Group: D

## Dependencies: Task 3

## Description

Surface cost estimation in three places across the CLI: (1) `fuel-code blueprint show` displays the estimated hourly cost for the configured instance type, (2) `fuel-code remote up` shows a cost estimate in the confirmation prompt before provisioning, and (3) `fuel-code remote ls` includes per-environment cost information (hourly rate and accrued cost). All cost data comes from the shared cost lookup table in Task 3.

### Blueprint Show: Cost Display

Add a "Cost Estimate" line to the `fuel-code blueprint show` output:

```
Blueprint: .fuel-code/env.yaml
  Runtime:        node 22 (bun)
  Base Image:     node:22-bookworm
  Instance Type:  t3.xlarge (4 vCPU, 16 GiB, ~$0.17/hr)
  Region:         us-east-1
  Disk:           50 GB
  Setup:          bun install
  Ports:          3000, 5432
  System Deps:    postgresql-client, make
  Est. Cost:      ~$0.17/hr (~$1.33/8hr, ~$4.00/24hr)
```

The cost line uses `getInstanceCost()` and `formatCostPerHour()` from the shared costs module. If the instance type is unknown, display `"Est. Cost: unknown (custom instance type)"`.

The projected costs for 8hr and 24hr help users understand the cost of a typical workday and leaving an environment running overnight.

### Remote Up: Confirmation Prompt

Before provisioning, `fuel-code remote up` shows a confirmation prompt that includes cost:

```
Provisioning remote environment:
  Instance:  t3.xlarge (4 vCPU, 16 GiB)
  Region:    us-east-1
  TTL:       8 hours
  Idle:      60 min auto-terminate
  Est. Cost: ~$0.17/hr (~$1.33 for 8hr TTL)

Proceed? [Y/n]
```

If `--yes` or `-y` flag is passed, skip the confirmation. If stdin is not a TTY (piped), skip the confirmation (proceed automatically, same as existing behavior).

The estimated total for the TTL is: `costPerHour * ttlMinutes / 60`. If cost is unknown, show `"Est. Cost: unknown"` but still allow provisioning.

### Remote Ls: Cost Column

Add cost information to the `fuel-code remote ls` table output:

```
ID              Status   Instance     Region      Uptime    Rate       Accrued
01HXYZ123...    active   t3.xlarge    us-east-1   2h 15m    ~$0.17/hr  ~$0.38
01HXYZ456...    idle     t3.large     us-east-1   5h 30m    ~$0.08/hr  ~$0.46
01HXYZ789...    ready    t3.xlarge    us-east-1   0h 12m    ~$0.17/hr  ~$0.03
```

- **Rate**: from `formatCostPerHour()` using the stored `cost_per_hour_usd` value (or lookup if not stored).
- **Accrued**: computed from `cost_per_hour_usd * uptime_hours`. If the environment is terminated, use the stored `total_cost_usd`.

### JSON Output

When `--json` is passed, cost fields are included in the JSON output:

```json
{
  "blueprint": {
    "instance_type": "t3.xlarge",
    "cost_per_hour_usd": 0.1664,
    "cost_estimate_8hr_usd": 1.3312,
    "cost_estimate_24hr_usd": 3.9936
  }
}
```

```json
{
  "remote_envs": [{
    "id": "01HXYZ...",
    "cost_per_hour_usd": 0.1664,
    "accrued_cost_usd": 0.38,
    "uptime_seconds": 8100
  }]
}
```

### Implementation Details

1. **No server changes needed**: The `remote_envs.cost_per_hour_usd` column is already populated at provisioning time. `total_cost_usd` is computed at termination. The CLI just needs to display this data.

2. **Accrued cost computation**: For running environments, the accrued cost is `cost_per_hour_usd * (now - ready_at) / 3600000`. For terminated environments, use the stored `total_cost_usd`.

3. **Table formatting**: Use the existing table formatting utilities in the CLI. Cost columns should be right-aligned for readability.

4. **Disclaimer**: All cost displays should note they are estimates. The `formatCostPerHour` function already uses `~` prefix.

### Relevant Files

**Modify:**
- `packages/cli/src/commands/blueprint.ts` — add cost line to `blueprint show` output
- `packages/cli/src/commands/remote-up.ts` — add cost to confirmation prompt
- `packages/cli/src/commands/remote-ls.ts` — add Rate and Accrued columns to table output
- `packages/cli/src/lib/format.ts` — add cost formatting helpers if needed (may use shared directly)

### Tests

`blueprint.test.ts` updates (bun:test):

1. `blueprint show` with known instance type → output includes "Est. Cost: ~$0.17/hr (~$1.33/8hr, ~$4.00/24hr)".
2. `blueprint show` with unknown instance type → output includes "Est. Cost: unknown (custom instance type)".
3. `blueprint show --json` → JSON includes `cost_per_hour_usd`, `cost_estimate_8hr_usd`, `cost_estimate_24hr_usd`.
4. `blueprint show --json` with unknown instance type → JSON has `cost_per_hour_usd: null`.

`remote-up.test.ts` updates (bun:test):

5. Confirmation prompt includes instance summary with cost rate.
6. Confirmation prompt includes estimated total for TTL duration.
7. `--yes` flag skips confirmation.
8. Non-TTY stdin skips confirmation.
9. Unknown instance type → "Est. Cost: unknown" in prompt, provisioning still allowed.

`remote-ls.test.ts` updates (bun:test):

10. Table output includes Rate and Accrued columns.
11. Running environment: accrued cost computed from `cost_per_hour_usd * uptime`.
12. Terminated environment: uses stored `total_cost_usd`.
13. Environment with unknown cost → "N/A" in cost columns.
14. `--json` output includes `cost_per_hour_usd` and `accrued_cost_usd` per environment.

### Success Criteria

1. `blueprint show` displays estimated hourly cost with 8hr and 24hr projections.
2. `remote up` confirmation includes cost estimate before provisioning.
3. `remote ls` shows per-environment rate and accrued cost.
4. Unknown instance types are handled gracefully — "unknown" or "N/A", never crashes.
5. All cost displays use `~` prefix to indicate estimates.
6. JSON output includes numeric cost fields for programmatic consumption.
7. `--yes` flag skips confirmation prompt (no UX regression).
8. Accrued cost for running environments is computed dynamically from uptime.
9. Accrued cost for terminated environments uses the stored total.
10. No server changes required — all data already available via existing API.
