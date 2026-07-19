import assert from 'node:assert/strict';
import { test } from 'node:test';
import { controlPlaneOptionsFromEnvironment } from '../src/main-config.js';

const humanToken = 'human-alpha-token-456789';
const observerReadToken = 'observer-read-token-789012';
const legacyToken = 'legacy-supervisor-token-123';

test('main rejects the legacy token by default and in production even with its opt-in flag', () => {
  for (const nodeEnvironment of [undefined, 'production']) {
    assert.throws(
      () =>
        controlPlaneOptionsFromEnvironment({
          NODE_ENV: nodeEnvironment,
          STEWARD_HUMAN_TOKEN: humanToken,
          STEWARD_OBSERVER_READ_TOKEN: observerReadToken,
          STEWARD_ENABLE_LEGACY_DEV_SUPERVISOR_TOKEN: 'true',
          STEWARD_LEGACY_DEV_SUPERVISOR_TOKEN: legacyToken,
        }),
      /only available when NODE_ENV is development or test/u,
    );
  }
});

test('main rejects a legacy token unless the separate opt-in is exactly true', () => {
  for (const enabled of [undefined, 'false']) {
    assert.throws(
      () =>
        controlPlaneOptionsFromEnvironment({
          NODE_ENV: 'development',
          STEWARD_HUMAN_TOKEN: humanToken,
          STEWARD_OBSERVER_READ_TOKEN: observerReadToken,
          STEWARD_ENABLE_LEGACY_DEV_SUPERVISOR_TOKEN: enabled,
          STEWARD_LEGACY_DEV_SUPERVISOR_TOKEN: legacyToken,
        }),
      /requires STEWARD_ENABLE_LEGACY_DEV_SUPERVISOR_TOKEN=true/u,
    );
  }
});

test('main rejects enabling the legacy credential without supplying its token', () => {
  assert.throws(
    () =>
      controlPlaneOptionsFromEnvironment({
        NODE_ENV: 'development',
        STEWARD_HUMAN_TOKEN: humanToken,
        STEWARD_OBSERVER_READ_TOKEN: observerReadToken,
        STEWARD_ENABLE_LEGACY_DEV_SUPERVISOR_TOKEN: 'true',
      }),
    /is required when the legacy credential is enabled/u,
  );
});

test('main enables the legacy credential only for an explicit development configuration', () => {
  const options = controlPlaneOptionsFromEnvironment(
    {
      NODE_ENV: 'development',
      STEWARD_HUMAN_TOKEN: humanToken,
      STEWARD_OBSERVER_READ_TOKEN: observerReadToken,
      STEWARD_ENABLE_LEGACY_DEV_SUPERVISOR_TOKEN: 'true',
      STEWARD_LEGACY_DEV_SUPERVISOR_TOKEN: legacyToken,
    },
    '/tmp/steward-main-config-test',
  );

  assert.equal(options.developmentMode, true);
  assert.equal(options.legacyDevSupervisorToken, legacyToken);
  assert.equal(options.host, '127.0.0.1');
});

test('main permits the explicit legacy fixture in test mode', () => {
  const options = controlPlaneOptionsFromEnvironment({
    NODE_ENV: 'test',
    STEWARD_HUMAN_TOKEN: humanToken,
    STEWARD_OBSERVER_READ_TOKEN: observerReadToken,
    STEWARD_ENABLE_LEGACY_DEV_SUPERVISOR_TOKEN: 'true',
    STEWARD_LEGACY_DEV_SUPERVISOR_TOKEN: legacyToken,
  });

  assert.equal(options.developmentMode, true);
  assert.equal(options.legacyDevSupervisorToken, legacyToken);
});

test('main defaults to lane-bound identities without a development escape hatch', () => {
  const options = controlPlaneOptionsFromEnvironment(
    {
      NODE_ENV: 'production',
      STEWARD_HUMAN_TOKEN: humanToken,
      STEWARD_OBSERVER_READ_TOKEN: observerReadToken,
      STEWARD_WORKLOAD_IDENTITIES_JSON: JSON.stringify([
        {
          workspaceId: 'workspace-alpha',
          agentId: 'agent-alpha',
          laneId: 'lane-alpha',
          role: 'engineer',
          token: 'lane-alpha-token-123456',
        },
      ]),
    },
    '/tmp/steward-main-config-test',
  );

  assert.equal(options.developmentMode, undefined);
  assert.equal(options.legacyDevSupervisorToken, undefined);
  assert.equal(options.observerReadToken, observerReadToken);
  assert.equal(options.workloadIdentities?.length, 1);
});

test('main requires a dedicated observer read token', () => {
  assert.throws(
    () =>
      controlPlaneOptionsFromEnvironment({
        NODE_ENV: 'production',
        STEWARD_HUMAN_TOKEN: humanToken,
        STEWARD_WORKLOAD_IDENTITIES_JSON: JSON.stringify([
          {
            workspaceId: 'workspace-alpha',
            agentId: 'agent-alpha',
            laneId: 'lane-alpha',
            role: 'engineer',
            token: 'lane-alpha-token-123456',
          },
        ]),
      }),
    /STEWARD_OBSERVER_READ_TOKEN is required/u,
  );
});
