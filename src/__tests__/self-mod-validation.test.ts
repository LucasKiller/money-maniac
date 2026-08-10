import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomatonDatabase } from "../types.js";
import { editFile } from "../self-mod/code.js";
import { createTestDb, MockConwayClient } from "./mocks.js";

describe("self-modification promotion pipeline", () => {
  const databases: AutomatonDatabase[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it("rolls content back when a validation fails", async () => {
    const db = createTestDb();
    databases.push(db);
    const conway = new MockConwayClient();
    conway.files["src/example.ts"] = "export const value = 1;";
    vi.spyOn(conway, "exec").mockImplementation(async (command) => ({
      stdout: "",
      stderr: command === "pnpm typecheck" ? "type error" : "",
      exitCode: command === "pnpm typecheck" ? 1 : 0,
    }));

    const result = await editFile(
      conway,
      db,
      "src/example.ts",
      "export const value: string = 1;",
      "test invalid edit",
    );

    expect(result).toEqual({
      success: false,
      error: "Validation typecheck failed; modification rolled back.",
    });
    expect(conway.files["src/example.ts"]).toBe("export const value = 1;");
    expect(db.getRecentModifications(1)[0]?.type).toBe("code_revert");
  });

  it("promotes only after all validation stages pass", async () => {
    const db = createTestDb();
    databases.push(db);
    const conway = new MockConwayClient();
    conway.files["src/example.ts"] = "export const value = 1;";

    const result = await editFile(
      conway,
      db,
      "src/example.ts",
      "export const value = 2;",
      "test valid edit",
    );

    expect(result).toEqual({ success: true });
    expect(conway.execCalls.map((call) => call.command)).toEqual(expect.arrayContaining([
      "pnpm typecheck",
      "pnpm test",
      "pnpm test:security",
      "pnpm build",
    ]));
    expect(db.getRecentModifications(1)[0]?.type).toBe("code_edit");
  });
});
