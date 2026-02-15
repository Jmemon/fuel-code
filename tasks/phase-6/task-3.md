# Task 3: Instance Type Cost Lookup Table

## Parallel Group: A

## Dependencies: None

## Description

Extract the cost estimation data from its current inline location in `remote-up.ts` into a shared module at `packages/shared/src/costs.ts`. Expand the existing 8-entry map to cover ~20 common instance types with approximate US East (us-east-1) on-demand hourly prices. Provide lookup functions for cost estimation that the CLI uses in `blueprint show`, `remote up` confirmation, and `remote ls` output. All prices are clearly labeled as estimates — no AWS Pricing API calls.

### Interface

```typescript
// packages/shared/src/costs.ts

export interface InstanceCostInfo {
  // Instance type (e.g., 't3.micro')
  instanceType: string;
  // vCPU count
  vcpus: number;
  // Memory in GiB
  memoryGib: number;
  // Approximate hourly cost in USD (US East on-demand)
  costPerHourUsd: number;
}

// Static map of instance types to cost info.
// All prices are approximate US East (us-east-1) on-demand pricing.
export const INSTANCE_COSTS: ReadonlyMap<string, InstanceCostInfo>;

// Look up cost info for an instance type. Returns undefined if not in the map.
export function getInstanceCost(instanceType: string): InstanceCostInfo | undefined;

// Estimate total cost for running an instance type for a given number of hours.
// Returns null if instance type is unknown.
export function estimateCost(instanceType: string, hours: number): number | null;

// Format a cost value as a human-readable string (e.g., "$1.23", "~$0.05/hr").
export function formatCostPerHour(costPerHourUsd: number): string;

// Format a total cost (e.g., "$4.56").
export function formatTotalCost(totalCostUsd: number): string;

// Format an instance type summary: "t3.xlarge (4 vCPU, 16 GiB, ~$0.17/hr)"
export function formatInstanceSummary(instanceType: string): string;
```

### Instance Types Covered

```typescript
// ~20 common instance types used for dev environments
const COST_DATA: [string, number, number, number][] = [
  // [type, vcpus, memGib, $/hr]
  ['t3.micro',     2,   1,   0.0104],
  ['t3.small',     2,   2,   0.0208],
  ['t3.medium',    2,   4,   0.0416],
  ['t3.large',     2,   8,   0.0832],
  ['t3.xlarge',    4,  16,   0.1664],
  ['t3.2xlarge',   8,  32,   0.3328],
  ['t3a.micro',    2,   1,   0.0094],
  ['t3a.small',    2,   2,   0.0188],
  ['t3a.medium',   2,   4,   0.0376],
  ['t3a.large',    2,   8,   0.0752],
  ['t3a.xlarge',   4,  16,   0.1504],
  ['m5.large',     2,   8,   0.0960],
  ['m5.xlarge',    4,  16,   0.1920],
  ['m5.2xlarge',   8,  32,   0.3840],
  ['m6i.large',    2,   8,   0.0960],
  ['m6i.xlarge',   4,  16,   0.1920],
  ['c5.large',     2,   4,   0.0850],
  ['c5.xlarge',    4,   8,   0.1700],
  ['r5.large',     2,  16,   0.1260],
  ['r5.xlarge',    4,  32,   0.2520],
];
```

### Formatting Details

- `formatCostPerHour(0.1664)` → `"~$0.17/hr"`  (rounded to 2 decimal places, prefixed with ~)
- `formatTotalCost(4.567)` → `"$4.57"`  (rounded to 2 decimal places)
- `formatTotalCost(0)` → `"$0.00"`
- `formatInstanceSummary('t3.xlarge')` → `"t3.xlarge (4 vCPU, 16 GiB, ~$0.17/hr)"`
- `formatInstanceSummary('unknown.type')` → `"unknown.type (cost unknown)"`

### Migration from remote-up.ts

Remove the `COST_PER_HOUR` map currently inlined in `packages/cli/src/commands/remote-up.ts` (or wherever it lives). Replace all references with imports from `packages/shared/src/costs.ts`. The `remote_envs.cost_per_hour_usd` column in Postgres continues to be populated at provisioning time using `getInstanceCost()`.

### Relevant Files

**Create:**
- `packages/shared/src/costs.ts`
- `packages/shared/src/__tests__/costs.test.ts`

**Modify:**
- `packages/shared/src/index.ts` — export cost functions and types
- `packages/cli/src/commands/remote-up.ts` — remove inline `COST_PER_HOUR` map, import from shared (if map exists here)
- `packages/server/src/services/provisioner.ts` — use `getInstanceCost()` to populate `cost_per_hour_usd` at provisioning (if not already using shared)

### Tests

`costs.test.ts` (bun:test):

1. `INSTANCE_COSTS` map contains all ~20 instance types.
2. `getInstanceCost('t3.xlarge')` returns `{ instanceType: 't3.xlarge', vcpus: 4, memoryGib: 16, costPerHourUsd: 0.1664 }`.
3. `getInstanceCost('nonexistent.type')` returns `undefined`.
4. `estimateCost('t3.xlarge', 8)` returns `0.1664 * 8 = 1.3312`.
5. `estimateCost('t3.xlarge', 0)` returns `0`.
6. `estimateCost('unknown', 8)` returns `null`.
7. `formatCostPerHour(0.1664)` returns `'~$0.17/hr'`.
8. `formatCostPerHour(0.0104)` returns `'~$0.01/hr'`.
9. `formatTotalCost(4.567)` returns `'$4.57'`.
10. `formatTotalCost(0)` returns `'$0.00'`.
11. `formatInstanceSummary('t3.xlarge')` returns `'t3.xlarge (4 vCPU, 16 GiB, ~$0.17/hr)'`.
12. `formatInstanceSummary('unknown.type')` returns `'unknown.type (cost unknown)'`.
13. All costs in the map are positive numbers.
14. All vcpu and memoryGib values are positive integers.
15. The map is read-only (cannot be mutated at runtime).

### Success Criteria

1. Cost data covers ~20 common instance types including t3, t3a, m5, m6i, c5, r5 families.
2. `getInstanceCost()` provides lookup with correct vCPU, memory, and price for all entries.
3. `estimateCost()` computes total cost correctly.
4. All format functions produce clean, human-readable strings.
5. Unknown instance types handled gracefully — `undefined` / `null` / `"cost unknown"`, never crashes.
6. The inline cost map in `remote-up.ts` is removed — single source of truth in shared.
7. Prices clearly approximate — format uses `~` prefix.
8. Module is in `packages/shared/` for use by both CLI and server.
