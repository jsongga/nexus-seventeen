import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { DocsPublishConfig, DocsPublishRepo } from "./config.js";
import { loadDocsPublishConfig } from "./config.js";
import { OutlineSink } from "./outline-sink.js";
import { publishRepo, type PublishReport } from "./publish.js";
import type { DocsSink, SinkCollection, SinkDocument } from "./sink.js";

interface CliOptions {
  readonly configPath: string;
  readonly repoName?: string;
  readonly dryRun: boolean;
}

type DocsSinkFactory = (
  outline: DocsPublishConfig["outline"],
  token: string,
) => DocsSink;

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function usage(): Error {
  return new Error("Usage: docs:publish [--config <path>] [--repo <name>] [--dry-run]");
}

function cliOptions(arguments_: readonly string[]): CliOptions {
  let configPath = "config/docs-publish.json";
  let repoName: string | undefined;
  let dryRun = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    switch (argument) {
      case "--config": {
        const value = arguments_[index + 1];
        if (value === undefined || value.length === 0) throw usage();
        configPath = value;
        index += 1;
        break;
      }
      case "--repo": {
        const value = arguments_[index + 1];
        if (value === undefined || value.length === 0) throw usage();
        repoName = value;
        index += 1;
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      default:
        throw usage();
    }
  }
  return Object.freeze({ configPath: resolve(configPath), repoName, dryRun });
}

class DryRunSink implements DocsSink {
  ensureCollection(repoName: string): Promise<SinkCollection> {
    return Promise.resolve(Object.freeze({ id: `dry-run:${repoName}`, name: `${repoName} docs` }));
  }

  listDocuments(_collection: SinkCollection): Promise<readonly SinkDocument[]> {
    return Promise.resolve(Object.freeze([]));
  }

  createDocument(_collection: SinkCollection, _title: string, _text: string): Promise<void> {
    return Promise.resolve();
  }

  updateDocument(_documentId: string, _title: string, _text: string): Promise<void> {
    return Promise.resolve();
  }

  archiveDocument(_documentId: string): Promise<void> {
    return Promise.resolve();
  }
}

function outlineSinkFactory(outline: DocsPublishConfig["outline"], token: string): DocsSink {
  return new OutlineSink({
    baseUrl: outline.baseUrl,
    allowInsecureBaseUrl: outline.allowInsecureBaseUrl,
    token,
  });
}

function selectedRepos(config: DocsPublishConfig, repoName: string | undefined): readonly DocsPublishRepo[] {
  if (repoName === undefined) return config.repos;
  const matches = config.repos.filter((repo) => repo.name === repoName);
  if (matches.length === 0) throw new Error(`Unknown docs publisher repo: ${repoName}`);
  return Object.freeze(matches);
}

function resolvedRepo(entry: DocsPublishRepo): DocsPublishRepo {
  return Object.freeze({ ...entry, path: resolve(entry.path) });
}

export async function runDocsPublishCli(
  arguments_: readonly string[],
  sinkFactory?: DocsSinkFactory,
): Promise<number> {
  const options = cliOptions(arguments_);
  const config = await loadDocsPublishConfig(options.configPath);
  const repos = selectedRepos(config, options.repoName);
  let sink: DocsSink;
  if (options.dryRun) {
    sink = new DryRunSink();
  } else {
    const token = required("STEWARD_OUTLINE_API_TOKEN");
    sink = (sinkFactory ?? outlineSinkFactory)(config.outline, token);
  }
  const reports: PublishReport[] = [];
  for (const entry of repos) {
    const report = await publishRepo(resolvedRepo(entry), sink);
    reports.push(report);
    console.log(JSON.stringify(report));
  }
  return reports.some((report) => report.failures.length > 0) ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runDocsPublishCli(process.argv.slice(2));
}
