# OpenClaw LLM Hook Investigation

## 問題陳述

從日誌分析發現，一個包含多次工具呼叫的 agent run 只觸發了：
- **1 次 `llm_input`**（開始時）
- **多次 `before_tool_call` / `after_tool_call`**（工具執行期間）
- **1 次 `llm_output`**（結束時）

但實際上 agent 應該進行了**多次 LLM 呼叫**來決定下一步動作：

```
實際流程:
LLM Call 1 → 決定使用 read tool (2次)
LLM Call 2 → 看完檔案後決定用 exec
LLM Call 3 → 決定再用 exec  
LLM Call 4 → 決定寫檔
LLM Call 5 → 最終回應

但 hook 只捕捉到:
llm_input (Call 1) → [7個工具呼叫] → llm_output (Call 5)
```

## 調查發現

### 1. Hook 觸發位置

查看 `openclaw/src/agents/pi-embedded-runner/run/attempt.ts`：

```typescript
// llm_input hook - 只在 prompt 開始時觸發一次
if (hookRunner?.hasHooks("llm_input")) {
  hookRunner.runLlmInput({
    runId: params.runId,
    provider: params.provider,
    model: params.modelId,
    systemPrompt: systemPromptText,
    prompt: effectivePrompt,
    historyMessages: activeSession.messages,
    // ...
  });
}

// llm_output hook - 只在整個 agent run 結束時觸發一次
if (hookRunner?.hasHooks("llm_output")) {
  hookRunner.runLlmOutput({
    runId: params.runId,
    assistantTexts,
    usage: getUsageTotals(),  // 累積所有 LLM 呼叫的 token 使用量
    // ...
  });
}
```

### 2. Agent Loop 架構

OpenClaw 使用 `pi-agent-core` 和 `pi-coding-agent` 來執行 agent loop：

```typescript
import { createAgentSession, SessionManager } from "@mariozechner/pi-coding-agent";
```

**關鍵發現：**
- Agent loop 的中間 LLM 呼叫（用於工具選擇）是在 `pi-agent-core` **內部**執行的
- OpenClaw 的 hook 系統位於 agent loop **外部**
- 因此無法直接捕捉中間的 LLM 呼叫

### 3. Token Usage 彙總

`llm_output` hook 中的 `usage` 是**累積值**：

```typescript
usage: getUsageTotals()  // 包含所有中間 LLM 呼叫的 token
```

從日誌：
```
usage={"input":44,"output":5378,"cacheRead":104499,"cacheWrite":78440,"total":188361}
```

這個巨大的 token 數量證明了有多次 LLM 呼叫，但它們被彙總成單一的使用量報告。

## 解決方案選項

### 方案 A：接受現狀（當前實現）

**優點：**
- 實現簡單
- 符合 OpenClaw 的 hook 設計
- 仍然提供有價值的追蹤資訊

**缺點：**
- 無法看到每個獨立的 LLM 決策循環
- Token usage 無法分配到具體的 Generation

**Langfuse 結構：**
```
Trace (agent run)
└─ Generation (整個會話)
   ├─ Span (tool_1)
   ├─ Span (tool_2)
   ├─ ...
   └─ Span (tool_7)
```

### 方案 B：從工具模式推斷 Generation（啟發式）

根據工具執行的時間間隔和類型變化推斷新的 LLM 呼叫：

```typescript
// 推斷規則：
1. 工具之間超過 5 秒間隔 → 可能是新的 LLM 決策
2. 工具類型改變 (read → exec → write) → 可能是新的決策階段
3. 連續相同工具 → 屬於同一個 Generation
```

**優點：**
- 提供更細緻的 Generation 分解
- 更接近實際的 LLM 行為

**缺點：**
- 啟發式規則不準確
- 無法取得每個 Generation 的實際 token usage
- 增加複雜度

### 方案 C：請求 OpenClaw 核心團隊增加 Hook

提交 feature request 到 OpenClaw：

**建議新增 hook：**
```typescript
// 在每次 agent loop iteration 開始時觸發
api.on("agent_iteration_start", (event, ctx) => {
  // event: { runId, iterationId, toolResults }
});

// 在每次 LLM 回應後觸發
api.on("agent_iteration_end", (event, ctx) => {
  // event: { runId, iterationId, assistantMessage, toolCalls, usage }
});
```

**優點：**
- 最準確的解決方案
- 社群其他使用者也能受益

**缺點：**
- 需要等待 OpenClaw 核心團隊實現
- 可能需要數週或數月

## 推薦方案

### 短期：方案 A（當前實現）

保持當前實現，並在文檔中清楚說明：

```markdown
## 限制

由於 OpenClaw 的 hook 機制限制，plugin 只能捕捉到 agent run 的開始和結束：

- **Trace** = 完整的 agent run
- **Generation** = 從開始到結束的所有 LLM 交互（可能包含多次內部 LLM 呼叫）
- **Span** = 每個工具呼叫（精確追蹤）

Token usage 是累積值，包含所有中間的 LLM 呼叫。
```

### 中期：方案 B（可選功能）

添加一個配置選項來啟用啟發式 Generation 推斷：

```json
{
  "config": {
    "inferGenerations": true,  // 啟用啟發式推斷（實驗性）
    "generationInferenceRules": {
      "timeGapSeconds": 5,
      "toolTypeChange": true
    }
  }
}
```

### 長期：方案 C（社群貢獻）

1. 向 OpenClaw 提交 issue/PR
2. 提議增加 `agent_iteration_*` hooks
3. 當新 hook 可用時，更新 plugin

## 當前狀態

✅ 已實現方案 A
- Trace → Generation → Span 結構正確
- 所有工具呼叫都作為 Span 正確嵌套
- 文檔需要更新以說明限制

## 下一步

1. 更新 README 和 HOOK.md 說明此限制
2. 添加 `inferGenerations` 配置（可選）
3. 向 OpenClaw 社群提出 hook enhancement request

## 參考

- `openclaw/src/agents/pi-embedded-runner/run/attempt.ts` - Agent execution
- `openclaw/src/plugins/hooks.ts` - Hook definitions
- `openclaw/src/plugins/types.ts` - Hook event types
