/* eslint-disable */
(function (OMP) {
  'use strict';
  /* ==========================================================================
     OMP Studio — mock changes + diffs

     Three provenance classes, kept strictly apart (§10):
       'turn'         — produced by the current Turn
       'thread'       — accumulated across this Thread
       'pre-existing' — already dirty before the Agent started

     Never let a pre-existing edit be attributed to OMP.
     ========================================================================== */

  const CHANGES = [
    {
      path: 'components/bridge/CapabilityProbe.tsx',
      status: 'A',
      provenance: 'turn',
      turn: 3,
      agent: 'main',
      additions: 96,
      deletions: 0,
      reviewed: false,
      /* 'declared' = the tool said it wrote; 'confirmed' = watcher saw it land */
      verification: 'declared',
      writingNow: true,
      binary: false,
    },
    {
      path: 'components/bridge/RpcClient.ts',
      status: 'M',
      provenance: 'turn',
      turn: 3,
      agent: 'main',
      additions: 3,
      deletions: 3,
      reviewed: false,
      verification: 'confirmed',
      watcherTs: '14:33:02',
      diagnostics: 2,
      binary: false,
    },
    {
      path: 'hooks/useRpc.ts',
      status: 'M',
      provenance: 'thread',
      turn: 2,
      agent: 'main',
      additions: 1,
      deletions: 1,
      reviewed: true,
      verification: 'confirmed',
      watcherTs: '14:12:48',
      diagnostics: 1,
      binary: false,
    },
    {
      path: 'components/MermaidBlock.tsx',
      status: 'R',
      renamedFrom: 'components/Mermaid.tsx',
      provenance: 'thread',
      turn: 1,
      agent: 'main',
      additions: 218,
      deletions: 0,
      reviewed: true,
      verification: 'confirmed',
      watcherTs: '14:05:19',
      binary: false,
    },
    {
      path: 'lib/protocol.ts',
      status: 'C',
      provenance: 'thread',
      turn: 1,
      agent: 'main',
      additions: 12,
      deletions: 3,
      reviewed: false,
      verification: 'confirmed',
      watcherTs: '14:05:41',
      conflict: true,
      binary: false,
    },
    {
      path: 'lib/legacy-transport.ts',
      status: 'D',
      provenance: 'thread',
      turn: 1,
      agent: 'main',
      additions: 0,
      deletions: 142,
      reviewed: true,
      verification: 'confirmed',
      watcherTs: '14:05:22',
      binary: false,
    },
    {
      path: 'package.json',
      status: 'M',
      provenance: 'thread',
      turn: 1,
      agent: 'main',
      additions: 6,
      deletions: 4,
      reviewed: true,
      verification: 'confirmed',
      watcherTs: '14:05:08',
      binary: false,
    },
    {
      path: 'bun.lockb',
      status: 'M',
      provenance: 'thread',
      turn: 2,
      agent: 'main',
      additions: 0,
      deletions: 0,
      reviewed: false,
      verification: 'confirmed',
      watcherTs: '14:12:31',
      binary: true,
      sizeBefore: '284 KB',
      sizeAfter: '291 KB',
    },
    /* ---- Pre-existing: the user's own uncommitted work. Must never be
       counted as an OMP change. ---- */
    {
      path: 'app/globals.css',
      status: 'M',
      provenance: 'pre-existing',
      turn: null,
      agent: null,
      additions: 14,
      deletions: 2,
      reviewed: false,
      verification: 'confirmed',
      watcherTs: '昨天 22:14',
      binary: false,
    },
    {
      path: 'public/preview.png',
      status: 'U',
      provenance: 'pre-existing',
      turn: null,
      agent: null,
      additions: 0,
      deletions: 0,
      reviewed: false,
      verification: 'confirmed',
      watcherTs: '昨天 22:09',
      binary: true,
      sizeAfter: '1.2 MB',
    },
  ];

  const PROVENANCE_LABEL = {
    turn: '本轮',
    thread: '本 Thread',
    'pre-existing': 'Agent 前已存在',
  };

  /* ---- Diff hunks --------------------------------------------------------
     kind: 'context' | 'add' | 'del' | 'meta'
     ------------------------------------------------------------------------ */
  const DIFFS = {
    'components/bridge/RpcClient.ts': {
      language: 'typescript',
      hunks: [
        {
          header: '@@ -78,12 +78,12 @@ export class RpcClient {',
          oldStart: 78, newStart: 78,
          lines: [
            { kind: 'context', old: 78, new: 78, text: '  private async handshake(): Promise<RpcHandshake> {' },
            { kind: 'context', old: 79, new: 79, text: '    const hs = await this.request<RpcHandshake>("initialize", {' },
            { kind: 'context', old: 80, new: 80, text: '      protocolVersion: PROTOCOL_VERSION,' },
            { kind: 'context', old: 81, new: 81, text: '    });' },
            { kind: 'context', old: 82, new: 82, text: '' },
            { kind: 'del', old: 83, text: '    // capabilities lived at the top level before v0.82' },
            { kind: 'del', old: 84, text: '    if (hs.capabilities?.includes("preview")) {' },
            { kind: 'del', old: 85, text: '      this.features.preview = true;' },
            { kind: 'add', new: 83, text: '    // upstream v0.82 moved capabilities under meta' },
            { kind: 'add', new: 84, text: '    if (hs.meta?.capabilities?.includes("preview")) {' },
            { kind: 'add', new: 85, text: '      this.features.preview = true;' },
            { kind: 'context', old: 86, new: 86, text: '    }' },
            { kind: 'context', old: 87, new: 87, text: '' },
            { kind: 'context', old: 88, new: 88, text: '    return hs;' },
            { kind: 'context', old: 89, new: 89, text: '  }' },
          ],
        },
      ],
    },

    'hooks/useRpc.ts': {
      language: 'typescript',
      hunks: [
        {
          header: '@@ -28,7 +28,7 @@ export function useRpc() {',
          oldStart: 28, newStart: 28,
          lines: [
            { kind: 'context', old: 28, new: 28, text: '  const probe = useCallback(async (name: string) => {' },
            { kind: 'context', old: 29, new: 29, text: '    if (!client) return false;' },
            { kind: 'context', old: 30, new: 30, text: '' },
            { kind: 'del', old: 31, text: '    return client.probeCapability(name);' },
            { kind: 'add', new: 31, text: '    return client.probeCapabilities().includes(name);' },
            { kind: 'context', old: 32, new: 32, text: '  }, [client]);' },
          ],
        },
      ],
    },

    'components/bridge/CapabilityProbe.tsx': {
      language: 'tsx',
      isNew: true,
      hunks: [
        {
          header: '@@ -0,0 +1,96 @@',
          oldStart: 0, newStart: 1,
          lines: [
            { kind: 'add', new: 1, text: "import { useEffect, useMemo, useState } from 'react';" },
            { kind: 'add', new: 2, text: "import { useRpc } from '@/hooks/useRpc';" },
            { kind: 'add', new: 3, text: "import type { Capability } from '@/lib/capability';" },
            { kind: 'add', new: 4, text: '' },
            { kind: 'add', new: 5, text: 'interface Props {' },
            { kind: 'add', new: 6, text: '  required?: Capability[];' },
            { kind: 'add', new: 7, text: '  onDegrade?: (missing: Capability[]) => void;' },
            { kind: 'add', new: 8, text: '  children: React.ReactNode;' },
            { kind: 'add', new: 9, text: '}' },
            { kind: 'add', new: 10, text: '' },
            { kind: 'add', new: 11, text: '/**' },
            { kind: 'add', new: 12, text: ' * Owns the capability list and availability checks so RpcClient can' },
            { kind: 'add', new: 13, text: ' * go back to being transport-only.' },
            { kind: 'add', new: 14, text: ' */' },
            { kind: 'add', new: 15, text: 'export function CapabilityProbe({ required = [], onDegrade, children }: Props) {' },
            { kind: 'add', new: 16, text: '  const { client, ready } = useRpc();' },
            { kind: 'add', new: 17, text: '  const [available, setAvailable] = useState<Capability[] | null>(null);' },
            { kind: 'add', new: 18, text: '' },
            { kind: 'add', new: 19, text: '  useEffect(() => {' },
            { kind: 'add', new: 20, text: '    if (!ready || !client) return;' },
            { kind: 'add', new: 21, text: '    setAvailable(client.probeCapabilities());' },
            { kind: 'add', new: 22, text: '  }, [ready, client]);' },
          ],
        },
      ],
    },

    'lib/protocol.ts': {
      language: 'typescript',
      conflict: true,
      hunks: [
        {
          header: '@@ -12,9 +12,18 @@',
          oldStart: 12, newStart: 12,
          lines: [
            { kind: 'context', old: 12, new: 12, text: 'export const PROTOCOL_VERSION = 3;' },
            { kind: 'context', old: 13, new: 13, text: '' },
            { kind: 'meta', text: '<<<<<<< HEAD (omp-web)' },
            { kind: 'add', new: 14, text: 'export interface RpcHandshake {' },
            { kind: 'add', new: 15, text: '  protocolVersion: number;' },
            { kind: 'add', new: 16, text: '  capabilities: Capability[];   // OMP: kept flat for our probe' },
            { kind: 'add', new: 17, text: '}' },
            { kind: 'meta', text: '=======' },
            { kind: 'del', old: 14, text: 'export interface RpcHandshake {' },
            { kind: 'del', old: 15, text: '  protocolVersion: number;' },
            { kind: 'del', old: 16, text: '  meta: { capabilities: Capability[] };' },
            { kind: 'del', old: 17, text: '}' },
            { kind: 'meta', text: '>>>>>>> v0.8.1 (upstream)' },
          ],
        },
      ],
    },

    'lib/legacy-transport.ts': {
      language: 'typescript',
      isDeleted: true,
      hunks: [
        {
          header: '@@ -1,142 +0,0 @@',
          oldStart: 1, newStart: 0,
          lines: [
            { kind: 'del', old: 1, text: "import { EventEmitter } from 'node:events';" },
            { kind: 'del', old: 2, text: '' },
            { kind: 'del', old: 3, text: '/** @deprecated replaced by lib/transport.ts in v0.8.1 */' },
            { kind: 'del', old: 4, text: 'export class LegacyTransport extends EventEmitter {' },
            { kind: 'del', old: 5, text: '  constructor(private url: string) {' },
            { kind: 'del', old: 6, text: '    super();' },
            { kind: 'del', old: 7, text: '  }' },
          ],
        },
      ],
    },

    'bun.lockb': {
      binary: true,
      sizeBefore: '284 KB',
      sizeAfter: '291 KB',
    },

    'app/globals.css': {
      language: 'css',
      hunks: [
        {
          header: '@@ -48,6 +48,18 @@',
          oldStart: 48, newStart: 48,
          lines: [
            { kind: 'context', old: 48, new: 48, text: ':root {' },
            { kind: 'context', old: 49, new: 49, text: '  --radius: 0.5rem;' },
            { kind: 'add', new: 50, text: '  /* my own tweak — not OMP */' },
            { kind: 'add', new: 51, text: '  --sidebar-w: 280px;' },
            { kind: 'context', old: 50, new: 52, text: '}' },
          ],
        },
      ],
    },
  };

  /* ---- File-change process states (§10) ---------------------------------- */
  const CHANGE_PROGRESS = {
    pending:   { label: '准备修改',      tone: 'muted' },
    writing:   { label: '正在写入',      tone: 'run' },
    changed:   { label: '文件已改变',    tone: 'accent' },
    building:  { label: '正在构建',      tone: 'run' },
    refreshed: { label: 'Preview 已刷新', tone: 'run' },
    verified:  { label: '验证通过',      tone: 'ok' },
    failed:    { label: '验证失败',      tone: 'danger' },
  };

  function changesByScope(scope) {
    if (scope === 'turn') return CHANGES.filter(c => c.provenance === 'turn');
    if (scope === 'thread') return CHANGES.filter(c => c.provenance === 'turn' || c.provenance === 'thread');
    return CHANGES.filter(c => c.provenance === 'pre-existing');
  }

  function changeTotals(list) {
    return list.reduce(
      (acc, c) => ({
        files: acc.files + 1,
        additions: acc.additions + c.additions,
        deletions: acc.deletions + c.deletions,
      }),
      { files: 0, additions: 0, deletions: 0 }
    );
  }


  OMP.mod['data/changes'] = { changesByScope, changeTotals, CHANGES, PROVENANCE_LABEL, DIFFS, CHANGE_PROGRESS };
})(window.OMP = window.OMP || { mod: {} });
