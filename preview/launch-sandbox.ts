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
  // Run detached and pull logs ourselves. In non-detached mode the SDK relies on
  // a long-lived log stream to detect completion; if that stream drops (a
  // transient runner<->Vercel blip) it throws StreamError ("stream_ended_early")
  // even when the command is fine. Streaming logs best-effort and then awaiting
  // wait() (which checks the command status, not the log stream) is resilient.
  const command = await sandbox.runCommand({ cmd, args, sudo: opts.sudo, detached: true });
  try {
    for await (const log of command.logs()) {
      const out = log.stream === 'stderr' ? process.stderr : process.stdout;
      out.write(log.data);
    }
  } catch (err) {
    console.warn(`\n[log stream ended early, falling back to status: ${(err as Error).message}]`);
  }
  const finished = await command.wait();
  if (finished.exitCode !== 0) {
    throw new Error(`Command failed (exit ${finished.exitCode}): ${cmd} ${args.join(' ')}`);
  }
}

async function waitForHealthy(url: string): Promise<void> {
  const deadline = Date.now() + HEALTHCHECK_TIMEOUT_MS;
  const healthUrl = `${url}/api/health`;
  console.log(`\nWaiting for Grafana to become healthy at ${healthUrl} ...`);
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    try {
      // Per-request timeout so a single stalled request can't hang the loop.
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(10_000) });
      console.log(`  attempt ${attempt}: HTTP ${res.status}`);
      if (res.ok) {
        console.log('Grafana is healthy.');
        return;
      }
    } catch (err) {
      // Container/Grafana not up yet (or request timed out); keep polling.
      console.log(`  attempt ${attempt}: ${(err as Error).message}`);
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

// Exit explicitly on both paths: the sandbox SDK keeps keep-alive sockets open,
// so the process would otherwise hang after the work is done. The sandbox itself
// keeps running on Vercel independently of this process until its timeout.
main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
