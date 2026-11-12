# 发布清单

仓库：<https://github.com/27Synthesis/dsh-companion-one>

## 1. 社交预览（Social preview）

1. 打开仓库 **Settings → Social preview → Edit**
2. 上传 `docs/cover.png`（1280×640）
3. 保存。之后把仓库链接发到聊天、Issue、社交平台，卡片就是这张封面

> GitHub 没有开放 Social preview 的写入 API，这一步只能手动传一次；`docs/cover.svg` 是源文件，改字后重新导出 PNG 即可。

## 2. 插件市场（awesome-dsh-plugin）

1. Fork <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin>
2. 新建 `data/plugins/27Synthesis__dsh-companion-one.yml`
3. 把 `MARKETPLACE.yml` 去掉开头注释后的正文粘进去（category 用 `memory`）
4. 开 PR，标题：`add 27Synthesis/dsh-companion-one`

PR 描述建议强调这句，市场上没人占这个位置：

> One plugin instead of five: memory, compression, persona, style learning, and companionship boundaries in a single self-contained SQLite-backed plugin for the dsh-go native phone UI — zero native builds, no traffic proxying, no extra model calls by default.

仓库 topic 已设置（`dsh-plugin` 在列），市场站点会自动扫描到。

## 3. 截图

已放入七张真机截图（dsh-go，均裁掉状态栏）：

| 文件 | 画面 |
| --- | --- |
| `docs/screenshots/overview.jpg` | 陪伴速览：心情、心声、压力、阀门、叙事 |
| `docs/screenshots/persona.jpg` | 人格页：当前叙事 v4、四阀门、推演层 |
| `docs/screenshots/memory.jpg` | 记忆页：只读扫描与合并其他插件记忆 |
| `docs/screenshots/learning.jpg` | 学习页：语料库、文风包、B 站联网学习 |
| `docs/screenshots/compression.jpg` | 压缩页：压力、可压缩范围、块列表 |
| `docs/screenshots/storage.jpg` | 存储页：库 / WAL / 空闲页与内容分组占比 |
| `docs/screenshots/storage-chat.jpg` | 聊天记录：按会话列条数，可单条删或清空 |

以后换图时保持同名覆盖即可，README 会直接引用。

## 4. CI（可选）

`.github/workflows/test.yml` 的完整内容备份在 `docs/ci-workflow.yml`（上次发布用的 token 没有 **Workflows** 写权限，远端暂未上传）。要启用 CI：

1. 把 `docs/ci-workflow.yml` 复制为 `.github/workflows/test.yml`
2. 用带 Workflows 权限的 token 推送，或在网页端新建该文件

## 5. 版本

已发布：`v0.1.0`（首个提交）、`v0.1.2`（2026-11-10，改动见 `CHANGELOG.md`）。
`v0.1.1` 是 11-09 的本地部署构建，没单独打标签，内容并入 `v0.1.2`。

发下一个版本：

```bash
# 1) 改 package.json 的 version，补 CHANGELOG
# 2) 提交
git add -A && git commit -m "feat: 这次改了什么"
# 3) 打标签并按标签推送（main 里别写标签名，否则报 ambiguous argument）
git tag -a v0.1.3 -m "companion-one v0.1.3"
git push origin refs/tags/v0.1.3:refs/tags/v0.1.3
git push origin main
```
