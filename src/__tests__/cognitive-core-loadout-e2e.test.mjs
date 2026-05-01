/**
 * Cross-repo e2e — cognitive-core publishes skills → skill-tree storage →
 * cc-swarm's compileAllRoleLoadouts materializes them via openteams template.
 *
 * Real components throughout, no mocks:
 *   - cognitive-core's `convertPlaybookToSkill` + `SkillPublisher` (real
 *     playbook → skill conversion, real write to FS storage)
 *   - skill-tree's `createSkillBank` (real file-backed storage)
 *   - cc-swarm's `compileAllRoleLoadouts` driving skill-tree's compile
 *   - hand-built openteams template-shape that includes the published IDs
 *
 * What this proves:
 *   - The metric-free Skill shape (post skill-tree 0.2 + cognitive-core
 *     Phase 3) round-trips through both publish (write) and compile
 *     (read) without losing any required fields.
 *   - cc-swarm's bridge (`mergeOpenteamsSkillsIntoCriteria`) correctly
 *     surfaces playbook-derived skills via `include: [...]`.
 *   - The full chain works end-to-end across three packages.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileAllRoleLoadouts } from '../skilltree-client.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function depsAvailable() {
  try {
    const cwd = path.resolve(__dirname, '../..');
    require.resolve('skill-tree', { paths: [cwd] });
    require.resolve('cognitive-core', { paths: [cwd] });
    return true;
  } catch {
    return false;
  }
}

const SKIP = !depsAvailable();

function makePlaybook(id, overrides = {}) {
  // Minimal Playbook shape that cognitive-core's convertPlaybookToSkill
  // can consume. Keeps imports light — we don't import createPlaybook
  // here because cognitive-core's deep import paths aren't directly
  // accessible from cc-swarm's runtime.
  const now = new Date();
  return {
    id,
    name: overrides.name ?? id,
    applicability: {
      situations: [overrides.situation ?? `Situation for ${id}`],
      triggers: [],
      antiPatterns: [],
      domains: overrides.domains ?? ['testing'],
    },
    guidance: {
      strategy: overrides.strategy ?? `Strategy: how to handle ${id}`,
      tactics: overrides.tactics ?? [],
      ...(overrides.codeExample && { codeExample: overrides.codeExample }),
    },
    verification: {
      successIndicators: ['operation completes'],
      failureIndicators: [],
    },
    evolution: {
      version: overrides.version ?? '1.0.0',
      createdFrom: ['session-x'],
      failures: [],
      refinements: [],
      successCount: overrides.successCount ?? 5,
      failureCount: overrides.failureCount ?? 1,
      lastUsed: now,
    },
    provenance: { origin: 'extracted', recordedAt: now },
    confidence: overrides.confidence ?? 0.85,
    complexity: 'moderate',
    estimatedEffort: 3,
    createdAt: now,
    updatedAt: now,
  };
}

describe.skipIf(SKIP)(
  'cross-repo e2e — cognitive-core skills → cc-swarm compile',
  () => {
    /** @type {string} */
    let basePath;

    beforeEach(async () => {
      basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cc-e2e-'));

      // Use cognitive-core's publisher to write skills into a real
      // skill-tree FilesystemStorageAdapter. This is the actual
      // cross-repo handshake.
      const ccCore = await import('cognitive-core');
      const st = await import('skill-tree');

      const bank = st.createSkillBank({ storage: { basePath } });
      await bank.initialize();

      const publisher = new ccCore.SkillPublisher(bank.getStorage());

      await publisher.publishPlaybook(
        makePlaybook('typescript-import-fix', {
          situation: 'TypeScript ESM build emits "Cannot find module"',
          strategy: 'Add .js extensions to all relative imports',
          tactics: ['Use codemod', 'Verify with tsc --noEmit'],
          domains: ['typescript', 'esm'],
        }),
      );
      await publisher.publishPlaybook(
        makePlaybook('react-rerender-bug', {
          situation: 'Component re-renders on every parent update',
          strategy: 'Wrap in React.memo and audit prop identity',
          tactics: ['useCallback for callbacks', 'useMemo for objects'],
          domains: ['react', 'performance'],
        }),
      );
      await publisher.publishPlaybook(
        makePlaybook('flaky-test-fix', {
          situation: 'Test passes locally, fails in CI',
          strategy: 'Eliminate timing dependencies with explicit waits',
          domains: ['testing'],
        }),
      );

      await bank.shutdown();
    });

    afterEach(() => {
      fs.rmSync(basePath, { recursive: true, force: true });
    });

    it('cc-swarm compiles a loadout including a cognitive-core-published skill', async () => {
      const manifest = { name: 'test-team', roles: ['developer'] };
      const template = {
        roles: new Map([
          [
            'developer',
            {
              loadout: {
                skills: { include: ['typescript-import-fix'] },
              },
            },
          ],
        ]),
      };

      const result = await compileAllRoleLoadouts(
        manifest,
        { basePath },
        template,
      );

      expect(result.developer).toBeDefined();
      expect(result.developer.content.length).toBeGreaterThan(0);
      // The skill content (from cognitive-core's convertPlaybookToSkill)
      // should appear in the rendered system prompt
      const lower = result.developer.content.toLowerCase();
      expect(lower).toContain('typescript-import-fix');
    });

    it('all three published skills are retrievable by id via skill-tree', async () => {
      const st = await import('skill-tree');
      const bank = st.createSkillBank({ storage: { basePath } });
      await bank.initialize();

      const ts = await bank.getSkill('typescript-import-fix');
      const react = await bank.getSkill('react-rerender-bug');
      const test = await bank.getSkill('flaky-test-fix');

      expect(ts).not.toBeNull();
      expect(react).not.toBeNull();
      expect(test).not.toBeNull();

      // All three have NO metrics field — proves the metric-free shape
      // survived publish and read across packages
      for (const skill of [ts, react, test]) {
        expect(skill.metrics).toBeUndefined();
        expect(skill.author).toBe('cognitive-core');
      }
      await bank.shutdown();
    });

    it('cc-swarm openteams overlay (max_tokens) flows through into skill-tree compile', async () => {
      // The bridge maps openteams `loadout.skills.max_tokens` → skill-tree
      // `criteria.maxTokens` (rename). Use a low budget to verify the
      // value reaches skill-tree's bundle limiter.
      const manifest = { name: 'test-team', roles: ['developer'] };
      const include = [
        'typescript-import-fix',
        'react-rerender-bug',
        'flaky-test-fix',
      ];
      const buildTemplate = (max_tokens) => ({
        roles: new Map([
          ['developer', { loadout: { skills: { include, max_tokens } } }],
        ]),
      });

      const low = await compileAllRoleLoadouts(
        manifest,
        { basePath },
        buildTemplate(1),
      );
      const high = await compileAllRoleLoadouts(
        manifest,
        { basePath },
        buildTemplate(100000),
      );

      const lowLen = low.developer?.content?.length ?? 0;
      const highLen = high.developer?.content?.length ?? 0;
      // High budget produces more content than effectively-zero budget —
      // proves max_tokens flows through the bridge into the compile
      expect(highLen).toBeGreaterThan(lowLen);
    });

    it('multiple roles bind to disjoint published skills', async () => {
      const manifest = {
        name: 'test-team',
        roles: ['ts-dev', 'react-dev', 'qa'],
      };
      const template = {
        roles: new Map([
          [
            'ts-dev',
            { loadout: { skills: { include: ['typescript-import-fix'] } } },
          ],
          [
            'react-dev',
            { loadout: { skills: { include: ['react-rerender-bug'] } } },
          ],
          [
            'qa',
            { loadout: { skills: { include: ['flaky-test-fix'] } } },
          ],
        ]),
      };

      const result = await compileAllRoleLoadouts(
        manifest,
        { basePath },
        template,
      );

      expect(result['ts-dev']?.content?.toLowerCase()).toContain(
        'typescript-import-fix',
      );
      expect(result['react-dev']?.content?.toLowerCase()).toContain(
        'react-rerender-bug',
      );
      expect(result['qa']?.content?.toLowerCase()).toContain(
        'flaky-test-fix',
      );
    });
  },
);
