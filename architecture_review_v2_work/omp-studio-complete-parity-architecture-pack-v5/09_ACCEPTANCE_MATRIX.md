# 09. Acceptance Matrix

## 1. Runtime classification

| Test ID | 场景 | 预期 |
|---|---|---|
| RT-001 | 签名有效 Managed Runtime | managed/full |
| RT-002 | System OMP 完整 Studio profile | compatible-system/full |
| RT-003 | 普通 upstream RPC v2 OMP | limited-system |
| RT-004 | 部分 Agent API | limited-system，缺失项可见 |
| RT-005 | manifest 声称 full 但 operation 不存在 | rejected |
| RT-006 | 用户禁止 Limited | Thread 创建被阻止 |
| RT-007 | Managed v2 激活失败 | 保留 v1 |

## 2. Protocol

| Test ID | 场景 | 预期 |
|---|---|---|
| PR-001 | valid hello | selected version/profile |
| PR-002 | invalid token | close，无信息泄露 |
| PR-003 | stale runtimeEpoch | reject |
| PR-004 | duplicate idempotency same op | old receipt |
| PR-005 | duplicate key different op | conflict |
| PR-006 | eventSeq gap | resync_required/snapshot |
| PR-007 | slow ephemeral consumer | coalesce/gap，不阻塞 Runtime |
| PR-008 | oversized frame | reject/close |
| PR-009 | crash after accepted | outcome_unknown |
| PR-010 | graceful shutdown | shutdown.complete then close |

## 3. Commands

对每个 built-in 自动生成以下 parameterized tests：

| Test | 要求 |
|---|---|
| manifest present | name/alias/source/route/risk/effect |
| valid invoke | accepted + terminal receipt |
| invalid args | typed INVALID_ARGUMENT |
| blocked state | typed error，不执行 mutation |
| TUI parity | TUI 与 Bridge 使用相同 service/postcondition |
| interaction | request/response/cancel/stale response |
| reconnect | terminal outcome 可恢复 |
| presentation | Native/Generic/Terminal 至少一个 |

重点 command 固定测试：

- CMD-PLAN-001..：enter/exit/paused/review/refine/approve/restore；
- CMD-GOAL-001..：create/budget/pause/resume/drop/complete/continuation；
- CMD-VIBE-001..：enter/toolset/workers/exit cleanup；
- CMD-LOOP-001..：limit/pause/resubmit/disable/shutdown；
- CMD-QUEUE-001..：idle/streaming/compacting/drain；
- CMD-SESSION-001..：clear/drop/tree/fork；
- CMD-RETRY-001..：failed tail/nothing/busy；
- CMD-BTW/TAN/OMFG；
- CMD-PAUSE/LIVE。

## 4. Agent Hub

| Test ID | 场景 | 预期 |
|---|---|---|
| AG-001 | list roster | no session path；revision stable |
| AG-002 | send running | injected/queued |
| AG-003 | send parked | ensureLive + revived/woken |
| AG-004 | stale generation send | conflict |
| AG-005 | spawn sync | Task semantics + terminal result |
| AG-006 | spawn async | agentId + jobId |
| AG-007 | kill | abort + tombstone release |
| AG-008 | revive | generation transition |
| AG-009 | release | non-tombstone lifecycle release |
| AG-010 | advisor mutation | rejected |
| AG-011 | cross-owner control | rejected |
| AG-012 | transcript cursor | incremental/no path leak |
| AG-013 | reconnect | roster revision/snapshot recover |

## 5. Jobs

| Test ID | 场景 | 预期 |
|---|---|---|
| JOB-001 | list owner jobs | scoped snapshot |
| JOB-002 | cancel running | cancellation requested/terminal event |
| JOB-003 | cancel terminal | already_terminal |
| JOB-004 | stale generation | conflict |
| JOB-005 | not owner | rejected |
| JOB-006 | jobless agent fallback | matches OMP Hub semantics |
| JOB-007 | Runtime crash | unknown/interrupted，不伪 completed |

## 6. Remote UI/TUI

| Test ID | 场景 | 预期 |
|---|---|---|
| UI-001 | confirm submit/cancel | deterministic service result |
| UI-002 | select | option id，不依赖 label |
| UI-003 | secret input | redacted logs |
| UI-004 | editor | content size limit/resource handle |
| UI-005 | approval replay | rejected |
| UI-006 | stale interaction | rejected |
| UI-007 | GUI→TUI transfer | lease generation changes |
| UI-008 | arbitrary custom TUI | terminal accessible |
| UI-009 | fake ANSI success | no semantic event |
| UI-010 | PTY disconnect | Bridge/session continues |

## 7. Security/recovery

| Test ID | 场景 | 预期 |
|---|---|---|
| SEC-001 | Renderer calls raw Bridge | impossible by API boundary |
| SEC-002 | token file other user | access denied |
| SEC-003 | stolen PTY ticket | one-time/replay rejected |
| SEC-004 | XSS destructive call | Host auth/confirmation blocks |
| SEC-005 | Runtime binary replaced after probe | identity mismatch/reprobe |
| REC-001 | Bridge reconnect | same Runtime snapshot |
| REC-002 | Runtime crash | new epoch, old events fenced |
| REC-003 | two Runtime attach same Thread | Host permits one owner only |
| REC-004 | external side effect before crash | outcome_unknown/no auto replay |

## 8. Full Parity release gate

Release job asserts：

```text
unclassifiedBuiltins == 0
missingRequiredCapabilities == 0
failedProtocolTests == 0
failedCommandContracts == 0
failedAgentJobContracts == 0
failedSecurityCriticalTests == 0
manifestHash == packagedManifestHash
signatureValid == true
```

任何断言失败，Managed build 不发布；System candidate 分类为 Limited 或 Rejected。

