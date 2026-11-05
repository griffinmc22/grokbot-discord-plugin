import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseRoomCommand } from "./room-commands.ts";

describe("parseRoomCommand", () => {
  it("parses slash commands without any bot name", () => {
    assert.deepEqual(parseRoomCommand("/status"), { kind: "status" });
    assert.deepEqual(parseRoomCommand("/new"), { kind: "new" });
    assert.deepEqual(parseRoomCommand("<@123456789012345678> /reset", ["Grok"]), { kind: "new" });
  });

  it("accepts conversational status asks in chat mode", () => {
    assert.deepEqual(parseRoomCommand("Grok are you up?", ["Grok"]), { kind: "status" });
  });

  it("only accepts explicit slash commands in slash-only (intake) mode", () => {
    assert.deepEqual(parseRoomCommand("/status", [], { slashOnly: true }), { kind: "status" });
    assert.deepEqual(parseRoomCommand("/new", [], { slashOnly: true }), { kind: "new" });
    assert.equal(parseRoomCommand("status?", [], { slashOnly: true }), null);
    assert.equal(parseRoomCommand("are you there?", [], { slashOnly: true }), null);
    assert.equal(parseRoomCommand("add dentist tuesday", [], { slashOnly: true }), null);
  });
});
