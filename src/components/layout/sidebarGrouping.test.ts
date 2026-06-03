// sidebarGrouping.test.ts — TDD: folder-first grouping with deriveGroup fallback
//
// These tests drive the extracted groupProfiles / deriveGroup seam.
// RED phase: tests written before implementation exists in sidebarGrouping.ts.

import { describe, it, expect } from "vitest";
import { groupProfiles, deriveGroup } from "./sidebarGrouping";
import type { ConnectionProfile } from "../../lib/types";

// ─── Minimal profile factory ──────────────────────────────────────────────────

function makeProfile(
  name: string,
  overrides: Partial<ConnectionProfile> = {},
): ConnectionProfile {
  return {
    id: crypto.randomUUID(),
    name,
    host: "example.com",
    port: 22,
    users: [],
    tunnels: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── deriveGroup fallback ─────────────────────────────────────────────────────

describe("deriveGroup", () => {
  it("matches production keywords", () => {
    expect(deriveGroup(makeProfile("prod-server"))).toBe("production");
    expect(deriveGroup(makeProfile("production-db"))).toBe("production");
    expect(deriveGroup(makeProfile("prd-01"))).toBe("production");
  });

  it("matches staging keywords", () => {
    expect(deriveGroup(makeProfile("stag-server"))).toBe("staging");
    expect(deriveGroup(makeProfile("staging-api"))).toBe("staging");
    expect(deriveGroup(makeProfile("uat-backend"))).toBe("staging");
  });

  it("matches development keywords", () => {
    expect(deriveGroup(makeProfile("dev-machine"))).toBe("development");
    expect(deriveGroup(makeProfile("develop-01"))).toBe("development");
  });

  it("matches certification keywords", () => {
    expect(deriveGroup(makeProfile("cert-server"))).toBe("certification");
    expect(deriveGroup(makeProfile("qa-node"))).toBe("certification");
  });

  it("falls back to other for unrecognized names", () => {
    expect(deriveGroup(makeProfile("server1"))).toBe("other");
    expect(deriveGroup(makeProfile("my-machine"))).toBe("other");
  });
});

// ─── groupProfiles: folder takes precedence ───────────────────────────────────

describe("groupProfiles", () => {
  it("groups profile under its folder when folder is set", () => {
    const p = makeProfile("server1", { folder: "my-team" });
    const groups = groupProfiles([p]);

    // Must appear under "my-team", not under deriveGroup result ("other")
    const myTeamGroup = groups.find((g) => g.key === "my-team");
    const otherGroup = groups.find((g) => g.key === "other");

    expect(myTeamGroup).toBeDefined();
    expect(myTeamGroup?.profiles).toContain(p);
    expect(otherGroup).toBeUndefined();
  });

  it("falls back to deriveGroup when folder is absent", () => {
    const p = makeProfile("prod-server");
    const groups = groupProfiles([p]);

    const productionGroup = groups.find((g) => g.key === "production");
    expect(productionGroup).toBeDefined();
    expect(productionGroup?.profiles).toContain(p);
  });

  it("falls back to deriveGroup when folder is empty string", () => {
    const p = makeProfile("prod-server", { folder: "" });
    const groups = groupProfiles([p]);

    const productionGroup = groups.find((g) => g.key === "production");
    expect(productionGroup).toBeDefined();
    expect(productionGroup?.profiles).toContain(p);
  });

  it("falls back to other when no folder and name does not match heuristic", () => {
    const p = makeProfile("server1");
    const groups = groupProfiles([p]);

    const otherGroup = groups.find((g) => g.key === "other");
    expect(otherGroup).toBeDefined();
    expect(otherGroup?.profiles).toContain(p);
  });

  it("emits only groups that have at least one profile", () => {
    const p = makeProfile("server1", { folder: "infra" });
    const groups = groupProfiles([p]);

    // Only "infra" should appear — no empty legacy groups
    expect(groups).toHaveLength(1);
    expect(groups[0]?.key).toBe("infra");
  });

  it("preserves profile insertion order within a group", () => {
    const p1 = makeProfile("server1", { folder: "infra" });
    const p2 = makeProfile("server2", { folder: "infra" });
    const groups = groupProfiles([p1, p2]);

    const infraGroup = groups.find((g) => g.key === "infra");
    expect(infraGroup).toBeDefined();
    expect(infraGroup!.profiles[0]).toBe(p1);
    expect(infraGroup!.profiles[1]).toBe(p2);
  });

  it("sorts user-assigned folders before heuristic groups", () => {
    const folderProfile = makeProfile("server1", { folder: "my-team" });
    const heuristicProfile = makeProfile("prod-server");
    const groups = groupProfiles([heuristicProfile, folderProfile]);

    // User-assigned folder should come first
    expect(groups[0]?.key).toBe("my-team");
    expect(groups[1]?.key).toBe("production");
  });

  it("handles empty profile list", () => {
    expect(groupProfiles([])).toHaveLength(0);
  });
});
