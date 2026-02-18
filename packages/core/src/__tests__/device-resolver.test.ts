/**
 * Tests for device-resolver.ts and workspace-device-link.ts
 *
 * Since we don't have a test Postgres instance, the postgres.js `sql`
 * client is mocked. The sql object is a tagged template literal function —
 * we mock it to capture the query and return expected results.
 *
 * These tests verify that:
 *   - resolveOrCreateDevice creates devices with default values
 *   - resolveOrCreateDevice passes hints into the SQL insert
 *   - updateDeviceLastSeen calls the correct SQL
 *   - ensureWorkspaceDeviceLink calls the correct SQL
 */

import { describe, expect, test } from "bun:test";
import {
  resolveOrCreateDevice,
  updateDeviceLastSeen,
} from "../device-resolver.js";
import { ensureWorkspaceDeviceLink } from "../workspace-device-link.js";

/**
 * Create a mock sql tagged template function.
 * See workspace-resolver.test.ts for full documentation.
 */
function createMockSql(resultRows: Record<string, unknown>[] = []) {
  const calls: { strings: string[]; values: unknown[] }[] = [];

  const sqlFn = (strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ strings: [...strings], values });
    return Promise.resolve(resultRows);
  };

  return { sql: sqlFn as any, calls };
}

describe("resolveOrCreateDevice", () => {
  test("creates new device with default name and type when no hints provided", async () => {
    const { sql, calls } = createMockSql([{ id: "device-123" }]);

    const result = await resolveOrCreateDevice(sql, "device-123");

    // Should return the device ID
    expect(result).toBe("device-123");

    // Should have made exactly one SQL call
    expect(calls).toHaveLength(1);

    const [call] = calls;
    // Values order: id, name, type, hostname, os, arch, metadata
    expect(call.values[0]).toBe("device-123"); // id
    expect(call.values[1]).toBe("unknown-device"); // default name
    expect(call.values[2]).toBe("local"); // default type
    expect(call.values[3]).toBeNull(); // hostname (no hint)
    expect(call.values[4]).toBeNull(); // os (no hint)
    expect(call.values[5]).toBeNull(); // arch (no hint)
    expect(call.values[6]).toBe("{}"); // empty metadata
  });

  test("passes all hints into SQL insert values", async () => {
    const { sql, calls } = createMockSql([{ id: "device-456" }]);

    const result = await resolveOrCreateDevice(sql, "device-456", {
      name: "my-laptop",
      type: "local",
      hostname: "macbook.local",
      os: "darwin",
      arch: "arm64",
    });

    expect(result).toBe("device-456");

    const [call] = calls;
    expect(call.values[0]).toBe("device-456"); // id
    expect(call.values[1]).toBe("my-laptop"); // name from hint
    expect(call.values[2]).toBe("local"); // type from hint
    expect(call.values[3]).toBe("macbook.local"); // hostname from hint
    expect(call.values[4]).toBe("darwin"); // os from hint
    expect(call.values[5]).toBe("arm64"); // arch from hint
  });

  test("uses default name when hint name is empty string", async () => {
    const { sql, calls } = createMockSql([{ id: "device-789" }]);

    await resolveOrCreateDevice(sql, "device-789", { name: "" });

    const [call] = calls;
    expect(call.values[1]).toBe("unknown-device");
  });

  test("remote device type is passed through", async () => {
    const { sql, calls } = createMockSql([{ id: "remote-001" }]);

    await resolveOrCreateDevice(sql, "remote-001", {
      name: "ec2-instance",
      type: "remote",
    });

    const [call] = calls;
    expect(call.values[2]).toBe("remote");
  });

  test("partial hints fill provided fields, nulls for the rest", async () => {
    const { sql, calls } = createMockSql([{ id: "device-partial" }]);

    await resolveOrCreateDevice(sql, "device-partial", {
      hostname: "server.local",
      // name, type, os, arch not provided
    });

    const [call] = calls;
    expect(call.values[0]).toBe("device-partial");
    expect(call.values[1]).toBe("unknown-device"); // default name
    expect(call.values[2]).toBe("local"); // default type
    expect(call.values[3]).toBe("server.local"); // hostname provided
    expect(call.values[4]).toBeNull(); // os not provided
    expect(call.values[5]).toBeNull(); // arch not provided
  });
});

describe("updateDeviceLastSeen", () => {
  test("calls UPDATE with the correct device ID", async () => {
    const { sql, calls } = createMockSql([]);

    await updateDeviceLastSeen(sql, "device-123");

    expect(calls).toHaveLength(1);

    const [call] = calls;
    // Should pass the device ID as the only interpolated value
    expect(call.values[0]).toBe("device-123");

    // The SQL template should contain UPDATE ... devices ... last_seen_at
    const queryText = call.strings.join("$");
    expect(queryText).toContain("UPDATE devices");
    expect(queryText).toContain("last_seen_at");
  });

  test("returns void (no result needed)", async () => {
    const { sql } = createMockSql([]);

    const result = await updateDeviceLastSeen(sql, "device-123");

    expect(result).toBeUndefined();
  });
});

describe("ensureWorkspaceDeviceLink", () => {
  test("calls INSERT with correct workspace, device, and path values", async () => {
    const { sql, calls } = createMockSql([]);

    await ensureWorkspaceDeviceLink(
      sql,
      "ws-ulid-123",
      "device-456",
      "/home/user/projects/repo",
    );

    expect(calls).toHaveLength(1);

    const [call] = calls;
    // Values order: workspace_id, device_id, local_path
    expect(call.values[0]).toBe("ws-ulid-123");
    expect(call.values[1]).toBe("device-456");
    expect(call.values[2]).toBe("/home/user/projects/repo");
  });

  test("SQL template contains ON CONFLICT for upsert", async () => {
    const { sql, calls } = createMockSql([]);

    await ensureWorkspaceDeviceLink(
      sql,
      "ws-ulid",
      "device-id",
      "/path/to/repo",
    );

    const [call] = calls;
    // Verify the SQL template includes upsert semantics
    const queryText = call.strings.join("$");
    expect(queryText).toContain("workspace_devices");
    expect(queryText).toContain("ON CONFLICT");
    expect(queryText).toContain("last_active_at");
  });

  test("returns void (no result needed)", async () => {
    const { sql } = createMockSql([]);

    const result = await ensureWorkspaceDeviceLink(
      sql,
      "ws-ulid",
      "device-id",
      "/path",
    );

    expect(result).toBeUndefined();
  });
});
