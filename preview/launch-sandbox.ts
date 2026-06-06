/*
 * Launches a time-boxed Grafana preview for a pull request inside a Vercel
 * Sandbox. The sandbox clones the PR's code, installs Docker, builds the image
 * defined in preview/Dockerfile, runs it, and exposes Grafana on a public URL.
 *
 * This is the orchestration that replaces Railway's native PR previews. It is
 * meant to run from .github/workflows/preview.yml (the trusted base-branch
 * launcher), not from inside the sandbox itself.
 *
 * Vercel Sandbox is ephemeral: the session auto-stops at `timeout`, so the
 * preview URL is short-lived. Re-trigger the workflow to refresh it. The script
 * exits as soon as the container is healthy; the sandbox keeps running on
 * Vercel independently of this process until its timeout.
 */
import { appendFileSync } from 'node:fs';
import { Sandbox } from '@vercel/sandbox';

const PORT = 3000;
// Keep below the Hobby cap (45 min); raise toward 5h on Pro/Enterprise if needed.
const TIMEOUT_MS = 50 * 60 * 1000;
const HEALTHCHECK_TIMEOUT_MS = 6 * 60 * 1000;
const HEALTHCHECK_INTERVAL_MS = 5 * 1000;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Expose a value to later GitHub Actions steps (and log it for humans). */
function setOutput(name: string, value: string): void {
  console.log(`${name}=${value}`);
  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(outputFile, `${name}=${value}\n`);
  }
}

async function run(sandbox: Sandbox, cmd: string, args: string[], opts: { sudo?: boolean } = {}): Promise<void> {
  console.log(`\n$ ${opts.sudo ? 'sudo ' : ''}${cmd} ${args.join(' ')}`);
  const command = await sandbox.runCommand({
    cmd,
    args,
    sudo: opts.sudo,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  if (command.exitCode !== 0) {
    throw new Error(`Command failed (exit ${command.exitCode}): ${cmd} ${args.join(' ')}`);
  }
}

async function waitForHealthy(url: string): Promise<void> {
  const deadline = Date.now() + HEALTHCHECK_TIMEOUT_MS;
  const healthUrl = `${url}/api/health`;
  console.log(`\nWaiting for Grafana to become healthy at ${healthUrl} ...`);
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) {
        console.log('Grafana is healthy.');
        return;
      }
    } catch {
      // Container/Grafana not up yet; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTHCHECK_INTERVAL_MS));
  }
  throw new Error(`Grafana did not become healthy within ${HEALTHCHECK_TIMEOUT_MS / 1000}s`);
}

async function main(): Promise<void> {
  const headRepoUrl = requireEnv('PR_HEAD_REPO_URL');
  const headSha = requireEnv('PR_HEAD_SHA');

  const sandbox = await Sandbox.create({
    token: requireEnv('VERCEL_TOKEN'),
    teamId: requireEnv('VERCEL_TEAM_ID'),
    projectId: requireEnv('VERCEL_PROJECT_ID'),
    source: {
      type: 'git',
      url: headRepoUrl,
      revision: headSha,
      depth: 1,
    },
    runtime: 'node24',
    resources: { vcpus: 4 },
    ports: [PORT],
    timeout: TIMEOUT_MS,
  });

  try {
    const url = sandbox.domain(PORT);
    console.log(`Sandbox created: ${sandbox.name}`);
    console.log(`Preview URL (provisioning): ${url}`);

    // Install and start the Docker daemon (requires the sandbox's sudo + microVM).
    await run(sandbox, 'dnf', ['install', '-y', 'docker'], { sudo: true });
    await sandbox.runCommand({ cmd: 'dockerd', sudo: true, detached: true });
    await run(sandbox, 'sh', ['-lc', 'until sudo docker info >/dev/null 2>&1; do sleep 1; done']);

    // Build the preview image from the cloned PR source, then run Grafana.
    await run(sandbox, 'docker', ['build', '-f', 'preview/Dockerfile', '-t', 'ch-preview', '.'], { sudo: true });
    await run(
      sandbox,
      'docker',
      ['run', '-d', '-p', `${PORT}:${PORT}`, '-e', `GF_SERVER_ROOT_URL=${url}`, '--name', 'grafana', 'ch-preview'],
      { sudo: true }
    );

    await waitForHealthy(url);

    setOutput('PREVIEW_URL', url);
    setOutput('SANDBOX_NAME', sandbox.name);
    setOutput('TIMEOUT_MINUTES', String(Math.round(TIMEOUT_MS / 60000)));
    console.log('\nPreview is live. The sandbox will auto-expire; re-run to refresh.');
  } catch (err) {
    // Tear down the broken sandbox so it does not keep consuming resources.
    console.error('\nFailed to launch preview, stopping sandbox.');
    await sandbox.stop().catch(() => undefined);
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
