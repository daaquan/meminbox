import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SetupCancelled } from "../src/errors.js";
import { chooseCliProject } from "../src/init.js";
import type { CliProject } from "../src/supabase-cli.js";

const app: CliProject = { ref: "appref", name: "my-app", linked: true };
const other: CliProject = { ref: "otherref", name: "memory", linked: false };

function scripted(...answers: string[]) {
  const asked: string[] = [];
  const prompt = async (q: string) => {
    asked.push(q);
    return answers.shift() ?? "";
  };
  return { prompt, asked };
}

describe("chooseCliProject", () => {
  it("never uses the linked project without confirmation", async () => {
    const { prompt, asked } = scripted("", "2");
    const chosen = await chooseCliProject([app, other], { yes: false }, prompt);
    assert.equal(asked.length, 2, "asked to confirm, then to select");
    assert.equal(chosen.ref, "otherref");
  });

  it("uses the linked project when the user confirms it", async () => {
    const { prompt } = scripted("y");
    const chosen = await chooseCliProject([app, other], { yes: false }, prompt);
    assert.equal(chosen.ref, "appref");
  });

  it("asks before using an account's only project, and cancels on no", async () => {
    const { prompt } = scripted("n");
    await assert.rejects(
      chooseCliProject([other], { yes: false }, prompt),
      SetupCancelled,
    );
  });

  it("--yes refuses to pick the linked project without --project-ref", async () => {
    await assert.rejects(
      chooseCliProject([app, other], { yes: true }, scripted().prompt),
      /--project-ref/,
    );
  });

  it("--yes accepts an account with exactly one project", async () => {
    const chosen = await chooseCliProject([other], { yes: true }, scripted().prompt);
    assert.equal(chosen.ref, "otherref");
  });

  it("--project-ref selects without prompting", async () => {
    const { prompt, asked } = scripted();
    const chosen = await chooseCliProject([app, other], { projectRef: "otherref", yes: false }, prompt);
    assert.equal(chosen.ref, "otherref");
    assert.equal(asked.length, 0);
  });
});
