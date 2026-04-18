/**
 * Worktree Mode Extension
 *
 * Executes large codebase changes in an isolated git worktree, then merges
 * the result back into the main branch after user review.
 *
 * How it works:
 *   1. User activates via /worktree command (or LLM suggests it)
 *   2. Extension creates a git worktree + temp branch
 *   3. All file-mutating tools (write, edit, bash) are path-rewritten
 *      so changes land in the worktree, not the main working tree
 *   4. When the agent finishes (agent_end), user is prompted to
 *      review the diff and merge or discard
 *   5. On merge: worktree branch is squash-merged into current branch,
 *      worktree cleaned up
 *   6. On discard: worktree and branch are deleted, no changes to main
 *
 * State is persisted in session entries so it survives compaction/reload.
 *
 * Commands:
 *   /worktree          — Activate worktree mode for the current task
 *   /worktree-status   — Show git diff of worktree changes
 *   /worktree-merge    — Merge worktree changes into current branch
 *   /worktree-discard  — Discard worktree changes without merging
 */

import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ENTRY_TYPE = "worktree-mode";
const BRANCH_PREFIX = "pi/worktree-";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

interface WorktreeState {
	/** Absolute path to the worktree directory */
	worktreeDir: string;
	/** Original cwd (the main working tree) */
	originalCwd: string;
	/** Branch name in the worktree */
	branchName: string;
	/** Whether we're in active worktree mode */
	active: boolean;
}

let state: WorktreeState | null = null;

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
	try {
		return execSync(`git ${args.join(" ")}`, {
			cwd,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
	} catch (err: any) {
		const stderr = err.stderr?.toString().trim() ?? err.message;
		throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr}`);
	}
}

function isGitRepo(cwd: string): boolean {
	try {
		git(cwd, "rev-parse", "--git-dir");
		return true;
	} catch {
		return false;
	}
}

function getMainWorktree(cwd: string): string {
	// Find the main working tree from any worktree or the main tree itself
	try {
		return git(cwd, "rev-parse", "--show-toplevel");
	} catch {
		return cwd;
	}
}

function hasUncommittedChanges(cwd: string): boolean {
	const status = git(cwd, "status", "--porcelain");
	return status.length > 0;
}

function getCurrentBranch(cwd: string): string {
	return git(cwd, "rev-parse", "--abbrev-ref", "HEAD");
}

function worktreeExists(worktreeDir: string): boolean {
	return existsSync(worktreeDir) && existsSync(join(worktreeDir, ".git"));
}

// ---------------------------------------------------------------------------
// Worktree lifecycle
// ---------------------------------------------------------------------------

async function createWorktree(pi: ExtensionAPI, ctx: ExtensionContext): Promise<WorktreeState> {
	if (state?.active) {
		throw new Error(`Worktree already active at ${state.worktreeDir}`);
	}

	const cwd = ctx.cwd;

	if (!isGitRepo(cwd)) {
		throw new Error("Not a git repository. Worktree mode requires git.");
	}

	// Create worktree branch name
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const branchName = `${BRANCH_PREFIX}${timestamp}`;

	// Create worktree: git worktree add -b <branch> <path> <start-point>
	const mainTree = getMainWorktree(cwd);
	const worktreePath = join(tmpdir(), `pi-worktree-${Date.now()}`);
	git(mainTree, "worktree", "add", "-b", branchName, worktreePath, "HEAD");

	// Verify worktree was created
	if (!existsSync(worktreePath)) {
		throw new Error(`Worktree directory was not created: ${worktreePath}`);
	}

	pi.appendEntry(ENTRY_TYPE, {
		worktreeDir: worktreePath,
		originalCwd: cwd,
		branchName,
		active: true,
	});

	state = {
		worktreeDir: worktreePath,
		originalCwd: cwd,
		branchName,
		active: true,
	};

	return state;
}

async function mergeWorktree(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	if (!state?.active) {
		throw new Error("No active worktree to merge.");
	}

	const { worktreeDir, branchName, originalCwd } = state;
	const mainTree = getMainWorktree(originalCwd);

	if (!worktreeExists(worktreeDir)) {
		throw new Error(`Worktree directory no longer exists: ${worktreeDir}`);
	}

	// Commit any uncommitted changes in the worktree
	if (hasUncommittedChanges(worktreeDir)) {
		git(worktreeDir, "add", "-A");
		git(worktreeDir, "commit", "-m", `worktree: changes from pi worktree mode (${branchName})`);
	}

	// Merge the worktree branch (squash) into the current branch in the main tree
	const _currentBranch = getCurrentBranch(mainTree);
	try {
		git(mainTree, "merge", "--squash", branchName);
		git(mainTree, "commit", "-m", `Merge pi worktree changes (${branchName})`);
	} catch (err: any) {
		// If merge fails, leave the state for manual resolution
		throw new Error(
			`Merge failed, resolve conflicts manually:\n${err.message}\n\nWorktree preserved at: ${worktreeDir}`,
		);
	}

	// Cleanup worktree
	await cleanupWorktree(pi, ctx);
}

async function discardWorktree(pi: ExtensionAPI, _ctx: ExtensionContext): Promise<void> {
	if (!state?.active) {
		throw new Error("No active worktree to discard.");
	}

	const { worktreeDir, branchName, originalCwd } = state;
	const mainTree = getMainWorktree(originalCwd);

	// Remove the worktree
	try {
		git(mainTree, "worktree", "remove", worktreeDir, "--force");
	} catch {
		// Force-remove if git can't
		try {
			rmSync(worktreeDir, { recursive: true, force: true });
		} catch {
			// Best effort
		}
	}

	// Delete the branch
	try {
		git(mainTree, "branch", "-D", branchName);
	} catch {
		// Branch might not exist if worktree was detached
	}

	// Prune worktree references
	try {
		git(mainTree, "worktree", "prune");
	} catch {
		// Ignore
	}

	state = null;
	pi.appendEntry(ENTRY_TYPE, { active: false });
}

async function cleanupWorktree(pi: ExtensionAPI, _ctx: ExtensionContext): Promise<void> {
	if (!state) return;

	const { worktreeDir, branchName, originalCwd } = state;
	const mainTree = getMainWorktree(originalCwd);

	// Remove the worktree directory
	try {
		git(mainTree, "worktree", "remove", worktreeDir, "--force");
	} catch {
		try {
			rmSync(worktreeDir, { recursive: true, force: true });
		} catch {
			// Best effort
		}
	}

	// Delete the branch
	try {
		git(mainTree, "branch", "-D", branchName);
	} catch {
		// Ignore
	}

	// Prune worktree references
	try {
		git(mainTree, "worktree", "prune");
	} catch {
		// Ignore
	}

	state = null;
	pi.appendEntry(ENTRY_TYPE, { active: false });
}

function getWorktreeDiff(): string {
	if (!state?.active) return "No active worktree.";

	const { worktreeDir, originalCwd } = state;
	const mainTree = getMainWorktree(originalCwd);

	try {
		let diff = "";

		// Diff committed changes against the merge base (common ancestor with main)
		try {
			const mergeBase = git(worktreeDir, "merge-base", "HEAD", getCurrentBranch(mainTree));
			const committedDiff = git(worktreeDir, "diff", mergeBase, "--stat");
			if (committedDiff) {
				diff += `--- Committed changes ---\n${committedDiff}\n\n`;
				diff += git(worktreeDir, "diff", mergeBase);
			}
		} catch {
			// No merge base yet (branch just created)
		}

		// Diff uncommitted (working tree) changes
		const uncommittedDiff = git(worktreeDir, "diff", "--stat");
		if (uncommittedDiff) {
			diff += `--- Uncommitted changes ---\n${uncommittedDiff}\n\n`;
			diff += git(worktreeDir, "diff");
		}

		return diff || "No changes in worktree.";
	} catch (err: any) {
		return `Error getting diff: ${err.message}`;
	}
}

// ---------------------------------------------------------------------------
// Path rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite a path from originalCwd to worktreeDir.
 * - Absolute paths under originalCwd → mapped to worktreeDir
 * - Relative paths → resolved against originalCwd first, then mapped
 * - Paths outside originalCwd → left unchanged
 */
function rewritePath(filePath: string, originalCwd: string, worktreeDir: string): string {
	// Strip leading @ (pi normalizes this in tools, but we run before the tool)
	const stripped = filePath.startsWith("@") ? filePath.slice(1) : filePath;

	const expanded = stripped.startsWith("~") ? stripped.replace("~", homedir()) : stripped;

	if (!isAbsolute(expanded)) {
		// Resolve relative to original cwd, then check if it's under the main tree
		const resolved = resolve(originalCwd, expanded);
		const mainTree = getMainWorktree(originalCwd);
		if (resolved.startsWith(`${mainTree}/`) || resolved === mainTree) {
			const rel = relative(mainTree, resolved);
			return join(worktreeDir, rel);
		}
		return expanded;
	}

	// Absolute path: check if it's under the main worktree
	const mainTree = getMainWorktree(originalCwd);
	if (expanded.startsWith(`${mainTree}/`) || expanded === mainTree) {
		const rel = relative(mainTree, expanded);
		return join(worktreeDir, rel);
	}

	return expanded;
}

/**
 * Rewrite file paths in bash commands.
 * This is a best-effort heuristic — we look for paths that match the originalCwd prefix
 * and rewrite them. We also prepend `cd <worktreeDir> &&` to ensure relative paths work.
 */
function rewriteBashCommand(command: string, originalCwd: string, worktreeDir: string): string {
	const mainTree = getMainWorktree(originalCwd);

	// Replace absolute paths pointing to the main tree
	const escapedMainTree = mainTree.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const re = new RegExp(escapedMainTree, "g");
	let rewritten = command.replace(re, worktreeDir);

	// Prepend cd to worktree so relative paths resolve there
	// Only if the command doesn't already start with cd
	if (!/^\s*cd\s/.test(rewritten)) {
		rewritten = `cd ${worktreeDir} && ${rewritten}`;
	}

	return rewritten;
}

// ---------------------------------------------------------------------------
// Tool call interception
// ---------------------------------------------------------------------------

const PATH_TOOLS = new Set(["read", "write", "edit", "ls", "find", "grep"]);

function interceptToolCall(event: any, _ctx: ExtensionContext): void {
	if (!state?.active) return;

	const { originalCwd, worktreeDir } = state;

	// Path-based tools: rewrite the `path` parameter
	if (PATH_TOOLS.has(event.toolName) && event.input) {
		if (typeof event.input.path === "string") {
			event.input.path = rewritePath(event.input.path, originalCwd, worktreeDir);
		}
		// Write tool also has content — no path in content to rewrite
	}

	// Bash: rewrite command
	if (event.toolName === "bash" && event.input?.command) {
		event.input.command = rewriteBashCommand(event.input.command, originalCwd, worktreeDir);
	}
}

// ---------------------------------------------------------------------------
// State restore from session
// ---------------------------------------------------------------------------

function restoreState(entries: Iterable<any>): void {
	// Find the most recent worktree entry
	let latest: any = null;
	for (const entry of entries) {
		if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
			latest = entry.data;
		}
	}

	if (latest?.active && latest.worktreeDir && latest.originalCwd && latest.branchName) {
		// Verify the worktree still exists
		if (worktreeExists(latest.worktreeDir)) {
			state = {
				worktreeDir: latest.worktreeDir,
				originalCwd: latest.originalCwd,
				branchName: latest.branchName,
				active: true,
			};
		}
		// If worktree doesn't exist anymore, leave state as null (inactive)
	}
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Restore state from session on startup
	pi.on("session_start", async (_event, ctx) => {
		restoreState(ctx.sessionManager.getEntries());
		if (state?.active) {
			ctx.ui.notify(`Worktree mode active: ${state.branchName}`, "info");
		}
	});

	// Intercept tool calls to rewrite paths
	pi.on("tool_call", async (event, ctx) => {
		interceptToolCall(event, ctx);
	});

	// Prompt user to review after agent finishes
	pi.on("agent_end", async (_event, ctx) => {
		if (!state?.active || !ctx.hasUI) return;

		// Only prompt if there are actual changes
		try {
			const diff = getWorktreeDiff();
			if (diff === "No changes in worktree." || diff.startsWith("Error")) return;
		} catch {
			return;
		}

		const choice = await ctx.ui.select("Worktree changes ready. What would you like to do?", [
			"Review changes (/worktree-status)",
			"Merge changes (/worktree-merge)",
			"Discard changes (/worktree-discard)",
			"Keep working (do nothing)",
		]);

		if (!choice) return;

		if (choice.includes("Review")) {
			ctx.ui.notify("Use /worktree-status to see the full diff, then /worktree-merge or /worktree-discard.", "info");
		} else if (choice.includes("Merge")) {
			pi.sendUserMessage("/worktree-merge", { deliverAs: "followUp" });
		} else if (choice.includes("Discard")) {
			pi.sendUserMessage("/worktree-discard", { deliverAs: "followUp" });
		}
		// "Keep working" — do nothing
	});

	// Clean up on session shutdown
	pi.on("session_shutdown", async (_event, ctx) => {
		if (!state?.active) return;

		if (ctx.hasUI) {
			const choice = await ctx.ui.select("Worktree mode is still active. Save changes before exiting?", [
				"Merge changes into current branch",
				"Discard changes",
				"Leave worktree for later (don't clean up)",
			]);

			if (choice?.includes("Merge")) {
				try {
					await mergeWorktree(pi, ctx);
					ctx.ui.notify("Worktree merged and cleaned up.", "info");
				} catch (err: any) {
					ctx.ui.notify(`Merge failed: ${err.message}`, "error");
				}
			} else if (choice?.includes("Discard")) {
				await discardWorktree(pi, ctx);
				ctx.ui.notify("Worktree discarded.", "info");
			}
			// "Leave" — don't clean up, user can come back
		}
	});

	// ---- Commands ----

	pi.registerCommand("worktree", {
		description: "Activate worktree mode — isolate file changes in a git worktree",
		handler: async (_args, ctx) => {
			if (state?.active) {
				ctx.ui.notify(`Worktree already active: ${state.branchName}\nDir: ${state.worktreeDir}`, "warning");
				return;
			}

			try {
				const wt = await createWorktree(pi, ctx);
				ctx.ui.notify(
					`Worktree created!\nBranch: ${wt.branchName}\nDir: ${wt.worktreeDir}\n\nAll file changes will go to the worktree. Use /worktree-status to review, /worktree-merge to apply, /worktree-discard to throw away.`,
					"info",
				);
			} catch (err: any) {
				ctx.ui.notify(`Failed to create worktree: ${err.message}`, "error");
			}
		},
	});

	pi.registerCommand("worktree-status", {
		description: "Show git diff of worktree changes",
		handler: async (_args, ctx) => {
			if (!state?.active) {
				ctx.ui.notify("No active worktree. Use /worktree to create one.", "warning");
				return;
			}

			try {
				const diff = getWorktreeDiff();
				if (!diff.trim()) {
					ctx.ui.notify("No changes in worktree.", "info");
				} else {
					// Truncate for display if needed
					const preview = diff.length > 5000 ? `${diff.slice(0, 5000)}\n...(truncated)` : diff;
					ctx.ui.notify(`Worktree diff:\n${preview}`, "info");
				}
			} catch (err: any) {
				ctx.ui.notify(`Error getting status: ${err.message}`, "error");
			}
		},
	});

	pi.registerCommand("worktree-merge", {
		description: "Merge worktree changes into current branch",
		handler: async (_args, ctx) => {
			if (!state?.active) {
				ctx.ui.notify("No active worktree to merge.", "warning");
				return;
			}

			if (ctx.hasUI) {
				const confirmed = await ctx.ui.confirm(
					"Merge worktree changes?",
					`This will squash-merge ${state.branchName} into your current branch.\nWorktree dir: ${state.worktreeDir}`,
				);
				if (!confirmed) return;
			}

			try {
				await mergeWorktree(pi, ctx);
				ctx.ui.notify("Worktree changes merged successfully!", "info");
			} catch (err: any) {
				ctx.ui.notify(`Merge failed: ${err.message}`, "error");
			}
		},
	});

	pi.registerCommand("worktree-discard", {
		description: "Discard worktree changes without merging",
		handler: async (_args, ctx) => {
			if (!state?.active) {
				ctx.ui.notify("No active worktree to discard.", "warning");
				return;
			}

			if (ctx.hasUI) {
				const confirmed = await ctx.ui.confirm(
					"Discard worktree changes?",
					`This will delete the worktree and branch ${state.branchName}. All changes will be lost.`,
				);
				if (!confirmed) return;
			}

			try {
				await discardWorktree(pi, ctx);
				ctx.ui.notify("Worktree discarded.", "info");
			} catch (err: any) {
				ctx.ui.notify(`Discard failed: ${err.message}`, "error");
			}
		},
	});
}
