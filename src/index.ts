import { getInput, setOutput, setFailed } from "@actions/core";
import { context, getOctokit } from "@actions/github";
import type { components } from "@octokit/openapi-types";
import * as yaml from "js-yaml";

async function run(): Promise<void> {
	try {
		const githubToken = getInput("github-token");
		const contributorsFile = getInput("contributors-file");

		// Determine pull request(s) to check, supporting both pull_request and merge_group events
		const pullRequests: Array<any> = (() => {
			if (context.payload.pull_request) {
				return [context.payload.pull_request];
			}
			if (
				context.eventName === "merge_group" &&
				Array.isArray((context.payload as any).merge_group?.pull_requests)
			) {
				return (context.payload as any).merge_group.pull_requests;
			}
			throw new Error("No pull request context available");
		})();

		const octokit = getOctokit(githubToken);

		// Fetch commits for all pull requests
		const commitResults = await Promise.all(
			pullRequests.map((pr: any) =>
				octokit.rest.pulls.listCommits({
					owner: context.repo.owner,
					repo: context.repo.repo,
					pull_number: pr.number,
				})
			)
		);
		const commits: Array<any> = commitResults.flatMap((res: any) => res.data);

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

		// Fetch CONTRIBUTORS file from each PR head
		const fileContentResponses = await Promise.all(
			pullRequests.map((pr: any) =>
				octokit.rest.repos.getContent({
					owner: pr.head.repo.owner.login,
					repo: pr.head.repo.name,
					path: contributorsFile,
					ref: pr.head.ref,
				})
			)
		);
		const contributors: string[] = fileContentResponses.flatMap(
			(response: any) => {
				const contentFile =
					response.data as components["schemas"]["content-file"];
				const raw = contentFile.content;
				const content = Buffer.from(raw, "base64").toString();
				return (yaml.load(content) ?? []) as string[];
			}
		);

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
