import { getInput, setOutput, setFailed } from "@actions/core";
import { context, getOctokit } from "@actions/github";
import type { components } from "@octokit/openapi-types";
import * as yaml from "js-yaml";

async function run(): Promise<void> {
	try {
		const githubToken = getInput("github-token");
		const contributorsFile = getInput("contributors-file");

		const octokit = getOctokit(githubToken);

		// Determine commits and contributors, handling both pull_request and merge_group events
		let commits: any[] = [];
		let contributors: string[] = [];
		if (context.payload.pull_request) {
			// Single pull request event
			const pr = context.payload
				.pull_request as components["schemas"]["pull-request"];
			const { data: prCommits } = await octokit.rest.pulls.listCommits({
				owner: context.repo.owner,
				repo: context.repo.repo,
				pull_number: pr.number,
			});
			commits = prCommits;
			const { data: contentData } = await octokit.rest.repos.getContent({
				owner: pr.head.repo!.owner.login,
				repo: pr.head.repo!.name,
				path: contributorsFile,
				ref: pr.head.ref,
			});
			const contentFile = contentData as components["schemas"]["content-file"];
			const raw = contentFile.content;
			const fileText = Buffer.from(raw, "base64").toString();
			contributors = (yaml.load(fileText) ?? []) as string[];
		} else if (context.eventName === "merge_group") {
			// Merge queue: compare commits between base and head_sha only
			const mg = (context.payload as any).merge_group;
			const { data: compareData } = await octokit.rest.repos.compareCommits({
				owner: context.repo.owner,
				repo: context.repo.repo,
				base: mg.base_sha as string,
				head: mg.head_sha as string,
			});
			commits = compareData.commits;
			// Load CONTRIBUTORS file at the merge-group temporary ref
			const { data: contentData } = await octokit.rest.repos.getContent({
				owner: context.repo.owner,
				repo: context.repo.repo,
				path: contributorsFile,
				ref: mg.head_ref as string,
			});
			const contentFile = contentData as components["schemas"]["content-file"];
			const raw = contentFile.content;
			const fileText = Buffer.from(raw, "base64").toString();
			contributors = (yaml.load(fileText) ?? []) as string[];
		} else {
			throw new Error("No pull request or merge group context available");
		}

		// Check for commits without GitHub user
		const missingAuthors = commits.filter(
			(commit: any) => !commit.author?.login
		);
		if (missingAuthors.length > 0) {
			throw new Error("PR contains commits without associated GitHub users");
		}

		// Extract author logins (excluding bots)
		const authors: string[] = Array.from(
			new Set(
				commits
					.filter((commit: any) => commit.author!.type.toLowerCase() !== "bot")
					.map((commit: any) => commit.author!.login)
			)
		).sort();

		// Determine missing CLA signatures
		const missing: string[] = authors.filter(
			(author) => !contributors.includes(author)
		);
		if (missing.length > 0) {
			console.log(
				`Not all contributors have signed the CLA. Missing: ${missing.join(
					", "
				)}`
			);
			setOutput(
				"missing",
				missing.map((login: string) => `@${login}`).join(", ")
			);
			setFailed(`Missing CLA signatures for ${missing.length} contributor(s)`);
			return;
		}
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err);
		setFailed(message);
	}
}

run();
