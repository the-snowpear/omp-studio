# 模型配置自动适配

供应商设置中的模型编辑器会根据模型 ID、名称和 API 类型推荐容量参数与思考配置。灰色值表示推荐值，点击现有的「保存模型 / 保存更改」即应用；在供应商表单内编辑时，还需保存供应商，才会写入 `models.yml`。

## 推荐与来源

- 优先级为 **手工 > 端点明确返回的元数据 > 模型目录**。未获取到的字段保持缺省，由 Runtime 处理，不填入通用的容量数字。
- 同供应商、API、模型 ID 的精确匹配优先。跨供应商按同 ID、显式别名和规范化名称匹配，但必须使用兼容 API。有不同配置的候选时，先选择目录模型，或直接手填。
- 名称规范化只统一大小写、空白、下划线和点号等分隔符，保留日期、模型版本、量化和能力后缀。近似名称只提供候选，不直接套用。
- 每项显示「目录 / 端点 / 手工」来源。「恢复推荐」清除该项手工覆盖；「重新应用推荐」获取当前目录的建议，保留其他手工覆盖。
- 保存后的值固定。目录更新不改写 `models.yml`，也不改变已打开草稿。要采用新版参数，主动点击「重新应用推荐」并保存。

来源记录位于 agent 配置目录的 `studio-model-origins.v1.json`，按供应商、模型及字段保存原始来源与当时的参数，不包含凭证。重开时与 YAML 实际值比较：外部修改过的字段显示为手工。删除来源文件不影响 Runtime 配置，只会丢失来源标注。

## 思考配置和角色

支持 `effort`、`budget`、`google-level`、`anthropic-adaptive`、`anthropic-budget-effort` 五种 `thinking.mode`，以及 `efforts/defaultLevel/effortMap/supportsDisplay/requiresEffort`。请求参数编码和预算计算仍由 OMP 完成。

部分原生模型依赖 `effortRouting/effortBudgets` 等不能在 `models.yml` 中表达的内部信息。这些条目仅推荐容量参数，并说明思考配置限制；原生供应商继续使用 Runtime 的完整能力。

角色切换模型时，保留已明确选择的档位；不支持时按 `minimal → low → medium → high → xhigh → max` 的距离映射，同距选择较高档位，并显示映射结果。没有明确档位时采用新模型的 `defaultLevel`。明确关闭保存为 `:off`，与「Runtime 默认」区分；要求必须思考的模型使用最低可用档位。

## 更新和维护目录

目录由项目固定 OMP commit 的 `pi-catalog` 生成，正常应用构建和启动不联网。模型页的「检查并更新目录」手动读取本仓库 `main` 分支的 `catalog/model-catalog-v1.json`。格式兼容的更新缓存在 agent 配置目录，网络失败时保留当前目录，没有缓存时使用内置目录。

维护命令：

```bash
npm run models:catalog:generate
npm run models:catalog:check
node --test scripts/model-catalog.test.mjs
```

别名在 `catalog/model-aliases.json` 维护，键为 `供应商/API/模型ID`，值为别名数组。目录 JSON 和内置模块应由同一次生成提交，通过 PR 更新，不手工修改生成文件。远程更新源在该文件合入 `main` 后生效。

预览模式使用演示目录和本地交互，不读取或保存真实配置。输入 `glm-5` 可查看唯一匹配，输入 `glm-5-gateway` 可演示目录候选有不同参数时的选择流程。
