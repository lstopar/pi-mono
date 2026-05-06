import { existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentSession } from "../src/core/sdk.js";
import {
	buildTreeFromEntries,
	type FileEntry,
	type LabelEntry,
	type SessionHeader,
	SessionManager,
	type SessionMessageEntry,
} from "../src/core/session-manager.js";

describe("createAgentSession session manager defaults", () => {
	let tempDir: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-sdk-session-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		cwd = join(tempDir, "project");
		agentDir = join(tempDir, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("uses agentDir for the default persisted session path", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
		});

		const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
		const expectedSessionDir = join(agentDir, "sessions", safePath);
		const sessionDir = session.sessionManager.getSessionDir();
		const sessionFile = session.sessionManager.getSessionFile();

		expect(sessionDir).toBe(expectedSessionDir);
		expect(sessionFile?.startsWith(`${expectedSessionDir}/`)).toBe(true);

		session.dispose();
	});

	it("keeps an explicit sessionManager override", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionManager = SessionManager.inMemory(cwd);
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.sessionManager.isPersisted()).toBe(false);

		session.dispose();
	});

	it("derives cwd from an explicit sessionManager when cwd is omitted", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		expect(model).toBeTruthy();

		const sessionCwd = join(tempDir, "session-project");
		mkdirSync(sessionCwd, { recursive: true });
		const sessionManager = SessionManager.inMemory(sessionCwd);
		const { session } = await createAgentSession({
			agentDir,
			model: model!,
			sessionManager,
		});

		expect(session.sessionManager).toBe(sessionManager);
		expect(session.systemPrompt).toContain(`Current working directory: ${sessionCwd}`);

		const bashTool = session.agent.state.tools.find((tool) => tool.name === "bash");
		expect(bashTool).toBeTruthy();
		const result = await bashTool!.execute("test", { command: "pwd" });
		const output = result.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("");

		expect(realpathSync(output.trim())).toBe(realpathSync(sessionCwd));

		session.dispose();
	});
});

// --- Helpers for buildTreeFromEntries tests ---

function userMsg(id: string, parentId: string | null, content: string, ts?: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: ts ?? new Date().toISOString(),
		message: { role: "user", content, timestamp: Date.now() },
	};
}

function assistantMsg(id: string, parentId: string | null, text: string, ts?: string): SessionMessageEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: ts ?? new Date().toISOString(),
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		},
	};
}

function labelEntry(
	id: string,
	parentId: string | null,
	targetId: string,
	label: string | undefined,
	ts?: string,
): LabelEntry {
	return {
		type: "label",
		id,
		parentId,
		timestamp: ts ?? new Date().toISOString(),
		targetId,
		label,
	};
}

function sessionHeader(id: string, ts?: string): SessionHeader {
	return {
		type: "session",
		id,
		timestamp: ts ?? new Date().toISOString(),
		cwd: "/tmp/test",
	};
}

describe("buildTreeFromEntries", () => {
	it("returns empty array for empty input", () => {
		const tree = buildTreeFromEntries([]);
		expect(tree).toEqual([]);
	});

	it("skips session header entries", () => {
		const entries: FileEntry[] = [sessionHeader("s1"), userMsg("u1", null, "hello")];
		const tree = buildTreeFromEntries(entries);
		expect(tree).toHaveLength(1);
		expect(tree[0]!.entry.id).toBe("u1");
	});

	it("builds a linear chain from parent-child relationships", () => {
		const entries: FileEntry[] = [
			userMsg("u1", null, "hello"),
			assistantMsg("a1", "u1", "hi"),
			userMsg("u2", "a1", "how are you"),
		];
		const tree = buildTreeFromEntries(entries);

		expect(tree).toHaveLength(1);
		expect(tree[0]!.entry.id).toBe("u1");
		expect(tree[0]!.children).toHaveLength(1);
		expect(tree[0]!.children[0]!.entry.id).toBe("a1");
		expect(tree[0]!.children[0]!.children).toHaveLength(1);
		expect(tree[0]!.children[0]!.children[0]!.entry.id).toBe("u2");
	});

	it("builds multiple roots when entries have null parentId", () => {
		const entries: FileEntry[] = [userMsg("u1", null, "first"), userMsg("u2", null, "second")];
		const tree = buildTreeFromEntries(entries);

		expect(tree).toHaveLength(2);
		expect(tree[0]!.entry.id).toBe("u1");
		expect(tree[1]!.entry.id).toBe("u2");
	});

	it("sorts children by timestamp (oldest first)", () => {
		const entries: FileEntry[] = [
			userMsg("u1", null, "hello"),
			userMsg("u3", "u1", "younger", new Date(Date.now() + 2000).toISOString()),
			userMsg("u2", "u1", "older", new Date(Date.now() + 1000).toISOString()),
		];
		const tree = buildTreeFromEntries(entries);

		expect(tree).toHaveLength(1);
		expect(tree[0]!.children).toHaveLength(2);
		expect(tree[0]!.children[0]!.entry.id).toBe("u2"); // older first
		expect(tree[0]!.children[1]!.entry.id).toBe("u3"); // younger second
	});

	it("promotes orphan to root when parentId references unknown entry", () => {
		const entries: FileEntry[] = [userMsg("u1", "nonexistent", "orphan")];
		const tree = buildTreeFromEntries(entries);

		expect(tree).toHaveLength(1);
		expect(tree[0]!.entry.id).toBe("u1");
	});

	it("handles self-referencing parentId as root", () => {
		const entries: FileEntry[] = [userMsg("u1", "u1", "self-ref")];
		const tree = buildTreeFromEntries(entries);

		expect(tree).toHaveLength(1);
		expect(tree[0]!.entry.id).toBe("u1");
	});

	it("resolves labels from LabelEntry entries", () => {
		const entries: FileEntry[] = [
			userMsg("u1", null, "hello"),
			assistantMsg("a1", "u1", "hi"),
			labelEntry("l1", null, "u1", "my-checkpoint"),
		];
		const tree = buildTreeFromEntries(entries);

		expect(tree).toHaveLength(1);
		expect(tree[0]!.label).toBe("my-checkpoint");
		expect(tree[0]!.labelTimestamp).toBeTruthy();
		// a1 has no label
		expect(tree[0]!.children[0]!.label).toBeUndefined();
	});

	it("removes label when LabelEntry has undefined label", () => {
		const entries: FileEntry[] = [
			userMsg("u1", null, "hello"),
			labelEntry("l1", null, "u1", "first-label"),
			labelEntry("l2", null, "u1", undefined), // removes label
		];
		const tree = buildTreeFromEntries(entries);

		expect(tree).toHaveLength(1);
		expect(tree[0]!.label).toBeUndefined();
		expect(tree[0]!.labelTimestamp).toBeUndefined();
	});

	it("uses the last label when multiple LabelEntries target the same entry", () => {
		const entries: FileEntry[] = [
			userMsg("u1", null, "hello"),
			labelEntry("l1", null, "u1", "first"),
			labelEntry("l2", null, "u1", "second"),
		];
		const tree = buildTreeFromEntries(entries);

		expect(tree).toHaveLength(1);
		expect(tree[0]!.label).toBe("second");
	});

	it("assigns labelTimestamp from the label entry", () => {
		const labelTs = new Date(2026, 0, 15, 10, 30, 0).toISOString();
		const entries: FileEntry[] = [userMsg("u1", null, "hello"), labelEntry("l1", null, "u1", "checkpoint", labelTs)];
		const tree = buildTreeFromEntries(entries);

		expect(tree[0]!.label).toBe("checkpoint");
		expect(tree[0]!.labelTimestamp).toBe(labelTs);
	});

	it("builds a branching tree with correct child ordering", () => {
		// u1 -> a1 -> u2 (branch A), u3 (branch B)
		const base = Date.now();
		const entries: FileEntry[] = [
			userMsg("u1", null, "hello", new Date(base).toISOString()),
			assistantMsg("a1", "u1", "hi", new Date(base + 1000).toISOString()),
			userMsg("u2", "a1", "branch A", new Date(base + 2000).toISOString()),
			userMsg("u3", "a1", "branch B", new Date(base + 3000).toISOString()),
		];
		const tree = buildTreeFromEntries(entries);

		expect(tree).toHaveLength(1);
		expect(tree[0]!.children[0]!.entry.id).toBe("a1");
		const a1 = tree[0]!.children[0]!;
		expect(a1.children).toHaveLength(2);
		expect(a1.children[0]!.entry.id).toBe("u2"); // older first
		expect(a1.children[1]!.entry.id).toBe("u3");
	});

	it("works with a mix of session header, labels, and messages", () => {
		const entries: FileEntry[] = [
			sessionHeader("s1"),
			userMsg("u1", null, "hello"),
			assistantMsg("a1", "u1", "hi"),
			labelEntry("l1", null, "u1", "start"),
			userMsg("u2", "a1", "bye"),
		];
		const tree = buildTreeFromEntries(entries);

		// Session header is skipped
		expect(tree).toHaveLength(1);
		expect(tree[0]!.entry.id).toBe("u1");
		expect(tree[0]!.label).toBe("start");
		expect(tree[0]!.children).toHaveLength(1);
		expect(tree[0]!.children[0]!.entry.id).toBe("a1");
		expect(tree[0]!.children[0]!.children).toHaveLength(1);
		expect(tree[0]!.children[0]!.children[0]!.entry.id).toBe("u2");
	});
});
